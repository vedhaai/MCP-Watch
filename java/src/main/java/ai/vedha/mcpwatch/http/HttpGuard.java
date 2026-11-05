package ai.vedha.mcpwatch.http;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;

import ai.vedha.mcpwatch.Engine;
import ai.vedha.mcpwatch.Json;

/**
 * Guarding MCP over HTTP (Streamable HTTP and SSE), whatever the web framework.
 *
 * <p>The servlet filter only moves bytes; this class decides. It mirrors the Node HTTP proxy and
 * the Python {@code mcpwatch/http.py}: the POST body carries client messages, the response is JSON
 * or an SSE stream of server messages.
 */
public final class HttpGuard {

	private final Engine engine;

	private final Predicate<String> matches;

	public HttpGuard(Engine engine, String... paths) {
		this(engine, List.of(paths));
	}

	public HttpGuard(Engine engine, List<String> paths) {
		this.engine = engine;
		this.matches = pathMatcher(paths);
	}

	public Engine engine() {
		return this.engine;
	}

	/** True when this path is the MCP endpoint and must be checked. */
	public boolean matches(String path) {
		return this.matches.test(path == null ? "" : path);
	}

	/** {@code /mcp} guards /mcp and anything under it; empty or {@code *} guards every path. */
	static Predicate<String> pathMatcher(List<String> paths) {
		if (paths == null || paths.isEmpty() || paths.contains("*")) {
			return path -> true;
		}
		List<String> prefixes = new ArrayList<>();
		for (String path : paths) {
			String trimmed = trimSlash(path);
			prefixes.add(trimmed.isEmpty() ? "/" : trimmed);
		}
		return path -> {
			String p = trimSlash(path);
			for (String prefix : prefixes) {
				if ("/".equals(prefix) || p.equals(prefix) || p.startsWith(prefix + "/")) {
					return true;
				}
			}
			return false;
		};
	}

	private static String trimSlash(String path) {
		String out = path == null ? "" : path;
		while (out.length() > 1 && out.endsWith("/")) {
			out = out.substring(0, out.length() - 1);
		}
		return out;
	}

	/**
	 * Checks a request before the application sees it: the transport rules for every method, and
	 * every client message in a POST body.
	 */
	public RequestCheck checkRequest(String method, Map<String, String> headers, byte[] body, String remote,
			boolean https) {
		Map<String, String> lower = new LinkedHashMap<>();
		if (headers != null) {
			headers.forEach((key, value) -> lower.put(key.toLowerCase(Locale.ROOT), value));
		}
		String sessionHeader = lower.get("mcp-session-id");
		String session = sessionHeader != null && !sessionHeader.isEmpty() ? sessionHeader : "http-" + remote;
		Map<String, Object> info = new LinkedHashMap<>();
		info.put("headers", lower);
		info.put("remoteAddress", remote);
		info.put("encrypted", https);

		String upper = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
		// A request carrying a session id is one the guard can hold to account: a server message
		// answering nothing the client asked for is forged (MW037).
		RequestCheck check = new RequestCheck(session, sessionHeader != null, upper, lower,
				body == null ? new byte[0] : body);

		if (!"POST".equals(upper)) {
			check.setRefuse(this.engine.fromHttp(session, info, upper));
			return check;
		}

		Object parsed = Json.parseOrNull(new String(check.body(), java.nio.charset.StandardCharsets.UTF_8));
		if (parsed == null) {
			return check; // Not JSON: not ours to judge.
		}
		List<Object> batch = Json.asArray(parsed);
		List<Object> messages = batch != null ? batch : List.of(parsed);

		List<Map<String, Object>> forwards = new ArrayList<>();
		List<Map<String, Object>> replies = new ArrayList<>();
		for (Object message : messages) {
			Map<String, Object> asObject = Json.asObject(message);
			if (asObject == null) {
				forwards.add(null);
				continue;
			}
			Engine.Outcome outcome = this.engine.fromClient(session, asObject, info);
			if (outcome.reply() != null) {
				replies.add(outcome.reply());
			}
			if (outcome.forward() != null) {
				forwards.add(outcome.forward());
			}
		}

		if (!replies.isEmpty()) {
			check.setReply(refusal(messages, replies, batch != null));
			return check;
		}
		if (!sameMessages(messages, forwards)) {
			Object out = batch != null ? forwards : (forwards.isEmpty() ? Map.of() : forwards.get(0));
			check.setBody(Json.write(out).getBytes(java.nio.charset.StandardCharsets.UTF_8));
		}
		return check;
	}

	/**
	 * Answer blocked calls ourselves. In a batch the rest are refused too, so nothing waits forever
	 * for a reply the application will never produce.
	 */
	private byte[] refusal(List<Object> messages, List<Map<String, Object>> replies, boolean batch) {
		if (!batch) {
			return Json.write(replies.get(0)).getBytes(java.nio.charset.StandardCharsets.UTF_8);
		}
		Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
		for (Map<String, Object> reply : replies) {
			byId.put(Json.write(reply.get("id")), reply);
		}
		List<Object> out = new ArrayList<>();
		for (Object message : messages) {
			Map<String, Object> asObject = Json.asObject(message);
			if (asObject == null || asObject.get("id") == null) {
				continue;
			}
			Map<String, Object> reply = byId.get(Json.write(asObject.get("id")));
			out.add(reply != null ? reply : refused(asObject.get("id")));
		}
		return Json.write(out).getBytes(java.nio.charset.StandardCharsets.UTF_8);
	}

	private static Map<String, Object> refused(Object id) {
		Map<String, Object> error = new LinkedHashMap<>();
		error.put("code", Engine.BLOCKED);
		error.put("message", "Batch refused by MCPWatch");
		Map<String, Object> reply = new LinkedHashMap<>();
		reply.put("jsonrpc", "2.0");
		reply.put("id", id);
		reply.put("error", error);
		return reply;
	}

	private static boolean sameMessages(List<Object> before, List<Map<String, Object>> after) {
		if (before.size() != after.size()) {
			return false;
		}
		for (int i = 0; i < before.size(); i++) {
			if (!before.get(i).equals(after.get(i))) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Call once the application has started its response; the filter checks the server's messages in
	 * it. A session id first handed out here is moved over, so the state gathered before it is kept.
	 */
	public ResponseFilter response(RequestCheck check, Map<String, String> headers, ReplyToServer replyToServer) {
		Map<String, String> lower = new LinkedHashMap<>();
		if (headers != null) {
			headers.forEach((key, value) -> {
				if (key != null) {
					lower.put(key.toLowerCase(Locale.ROOT), value);
				}
			});
		}
		String newSession = lower.get("mcp-session-id");
		if (newSession != null && !newSession.isEmpty() && !newSession.equals(check.session())) {
			this.engine.renameSession(check.session(), newSession);
			check.setSession(newSession);
		}
		String contentType = lower.getOrDefault("content-type", "");
		return new ResponseFilter(this, check, contentType, replyToServer);
	}

	/** After the response: a DELETE ends the session. */
	public void finished(RequestCheck check) {
		if ("DELETE".equals(check.method())) {
			this.engine.dropSession(check.session());
		}
	}

	/** How a reply the guard owes the server (a refused sampling request) gets back to it. */
	@FunctionalInterface
	public interface ReplyToServer {

		void send(Map<String, Object> message);

	}
}
