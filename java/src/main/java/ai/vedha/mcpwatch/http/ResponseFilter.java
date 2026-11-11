package ai.vedha.mcpwatch.http;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CoderResult;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import ai.vedha.mcpwatch.Engine;
import ai.vedha.mcpwatch.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Checks the server's messages in a response body: a JSON body whole, an SSE stream event by event.
 *
 * <p>An SSE stream arrives in arbitrary chunks, so bytes are decoded incrementally and a partial
 * event is held back until its terminating blank line arrives. Only complete events are judged, and
 * only complete events are passed on.
 */
public final class ResponseFilter {

	private static final Logger log = LoggerFactory.getLogger("mcpwatch");

	/** What sort of body this is, and so what the filter does with it. */
	public enum Kind {

		/** {@code application/json}: one body, checked whole. */
		JSON,
		/** {@code text/event-stream}: checked event by event as it streams. */
		SSE,
		/** Anything else: passed through untouched. */
		RAW

	}

	private final HttpGuard guard;

	private final RequestCheck check;

	private final Kind kind;

	private final HttpGuard.ReplyToServer replyToServer;

	private final CharsetDecoder decoder;

	private final StringBuilder buffer = new StringBuilder();

	/** The last chunk ended on a bare CR that closed an event; a following LF belongs to it. */
	private boolean swallowLf;

	ResponseFilter(HttpGuard guard, RequestCheck check, String contentType, HttpGuard.ReplyToServer replyToServer) {
		this.guard = guard;
		this.check = check;
		String type = contentType == null ? "" : contentType;
		this.kind = type.contains("text/event-stream") ? Kind.SSE
				: type.contains("application/json") ? Kind.JSON : Kind.RAW;
		this.replyToServer = replyToServer;
		this.decoder = StandardCharsets.UTF_8.newDecoder()
			.onMalformedInput(CodingErrorAction.REPLACE)
			.onUnmappableCharacter(CodingErrorAction.REPLACE);
	}

	public Kind kind() {
		return this.kind;
	}

	/** A whole JSON body, checked. Anything else is returned unchanged. */
	public byte[] json(byte[] body) {
		if (this.kind != Kind.JSON) {
			return body;
		}
		Object parsed = Json.parseOrNull(new String(body, StandardCharsets.UTF_8));
		if (parsed == null) {
			return body;
		}
		List<Object> batch = Json.asArray(parsed);
		List<Object> messages = batch != null ? batch : List.of(parsed);
		List<Object> out = new ArrayList<>();
		for (Object message : messages) {
			Map<String, Object> asObject = Json.asObject(message);
			if (asObject == null) {
				out.add(message);
				continue;
			}
			Map<String, Object> forward = guarded(asObject);
			if (forward != null) {
				out.add(forward);
			}
		}
		Object result = batch != null ? out : (out.isEmpty() ? Map.of() : out.get(0));
		return Json.write(result).getBytes(StandardCharsets.UTF_8);
	}

	/** SSE: the complete events in {@code chunk} (and before it), checked. Partial events wait. */
	public byte[] feed(byte[] chunk) {
		if (this.kind != Kind.SSE) {
			return chunk;
		}
		decode(chunk, false);
		// A boundary that ran to the end of the last chunk on a bare CR may have been half of a
		// CRLF. Holding the event back to find out would stall the stream, so it went out and the
		// LF is dropped here instead -- otherwise it reads as a blank line opening the next event.
		if (this.swallowLf && this.buffer.length() > 0) {
			if (this.buffer.charAt(0) == '\n') {
				this.buffer.deleteCharAt(0);
			}
			this.swallowLf = false;
		}
		StringBuilder out = new StringBuilder();
		int end;
		while ((end = endOfEvent(this.buffer)) >= 0) {
			int boundary = boundaryLength(this.buffer, end);
			String event = this.buffer.substring(0, end);
			boolean endedOnCr = this.buffer.charAt(end + boundary - 1) == '\r';
			this.buffer.delete(0, end + boundary);
			this.swallowLf = endedOnCr && this.buffer.length() == 0;
			out.append(event(event));
		}
		return out.toString().getBytes(StandardCharsets.UTF_8);
	}

	/** Whatever is left when the stream ends: a last event with no terminating blank line. */
	public byte[] end() {
		if (this.kind != Kind.SSE) {
			return new byte[0];
		}
		decode(new byte[0], true);
		String rest = this.buffer.toString();
		this.buffer.setLength(0);
		return rest.isBlank() ? new byte[0] : event(rest).getBytes(StandardCharsets.UTF_8);
	}

	private void decode(byte[] chunk, boolean last) {
		ByteBuffer in = ByteBuffer.wrap(chunk);
		CharBuffer out = CharBuffer.allocate(Math.max(16, chunk.length + 4));
		while (true) {
			CoderResult result = this.decoder.decode(in, out, last);
			out.flip();
			this.buffer.append(out);
			out.clear();
			if (result.isUnderflow()) {
				break;
			}
			if (result.isOverflow()) {
				continue;
			}
			// REPLACE is set for both error kinds, so nothing else can come back.
			break;
		}
		if (last) {
			while (this.decoder.flush(out) == CoderResult.OVERFLOW) {
				out.flip();
				this.buffer.append(out);
				out.clear();
			}
			out.flip();
			this.buffer.append(out);
		}
	}

	/**
	 * The index where the next complete event ends, or -1 while it is still arriving.
	 *
	 * <p>SSE ends a line with CRLF, LF or <i>or</i> a bare CR, and an event at the first blank line,
	 * so any two terminators in a row close one — including the mixed pairs that appear when a proxy
	 * or a framework rewrites part of a stream. Matching only {@code \n\n}, {@code \r\n\r\n} and
	 * {@code \r\r} left {@code \r\n\n} and {@code \n\r\n} unrecognised, and an event the guard never
	 * sees the end of is an event it never checks.
	 */
	private static int endOfEvent(CharSequence text) {
		for (int i = 0; i < text.length(); i++) {
			int first = terminatorAt(text, i);
			if (first == 0) {
				continue;
			}
			if (terminatorAt(text, i + first) > 0) {
				return i;
			}
		}
		return -1;
	}

	/** The length of the line terminator at {@code at} — CRLF, LF or CR — or 0 if there is none. */
	private static int terminatorAt(CharSequence text, int at) {
		if (at >= text.length()) {
			return 0;
		}
		char c = text.charAt(at);
		if (c == '\r') {
			return at + 1 < text.length() && text.charAt(at + 1) == '\n' ? 2 : 1;
		}
		return c == '\n' ? 1 : 0;
	}

	/** The blank line that closed the event: the two terminators starting at {@code at}. */
	private static int boundaryLength(CharSequence text, int at) {
		int first = terminatorAt(text, at);
		return first + terminatorAt(text, at + first);
	}

	/** One complete SSE event: note its id, check its data, and rebuild it if the guard changed it. */
	private String event(String event) {
		// Every terminator SSE allows, not just CRLF and LF: a bare CR separates lines too.
		String[] lines = event.split("\r\n|\n|\r", -1);
		StringBuilder data = new StringBuilder();
		List<String> keep = new ArrayList<>();
		for (String line : lines) {
			if (line.startsWith("id:")) {
				String id = line.substring(3).trim();
				if (!id.isEmpty()) {
					// MW037: a stream resumed with another session's event id.
					this.guard.engine().noteEventId(this.check.session(), id);
				}
				keep.add(line);
			}
			else if (line.startsWith("data:")) {
				String part = line.substring(5);
				if (part.startsWith(" ")) {
					part = part.substring(1);
				}
				if (data.length() > 0) {
					data.append('\n');
				}
				data.append(part);
			}
			else {
				keep.add(line);
			}
		}
		if (data.length() == 0) {
			return event + "\n\n";
		}
		Map<String, Object> message = Json.parseObject(data.toString());
		if (message == null) {
			return event + "\n\n";
		}
		Map<String, Object> forward = guarded(message);
		if (forward == null) {
			return "";
		}
		StringBuilder out = new StringBuilder();
		for (String line : keep) {
			out.append(line).append('\n');
		}
		out.append("data: ").append(Json.write(forward)).append("\n\n");
		return out.toString();
	}

	private Map<String, Object> guarded(Map<String, Object> message) {
		Engine.Outcome outcome = this.guard.engine().fromServer(this.check.session(), message, this.check.strict());
		if (outcome.reply() != null) {
			if (this.replyToServer != null) {
				this.replyToServer.send(outcome.reply());
			}
			else {
				log.warn("[mcpwatch] refused {} from the server; it gets no answer here", message.get("method"));
			}
		}
		return outcome.forward();
	}
}
