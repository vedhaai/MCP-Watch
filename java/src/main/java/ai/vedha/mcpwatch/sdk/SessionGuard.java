package ai.vedha.mcpwatch.sdk;

import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

import ai.vedha.mcpwatch.Engine;
import ai.vedha.mcpwatch.Json;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.spec.McpSchema;
import io.modelcontextprotocol.spec.McpSchema.JSONRPCMessage;
import io.modelcontextprotocol.spec.McpServerSession;
import io.modelcontextprotocol.spec.McpServerTransport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One guarded connection: the engine, the session it belongs to, and the ordering of the checks in
 * each direction.
 *
 * <p>The SDK hands out one transport and one session per connected client, so a session here is a
 * connection: for stdio the single one, for SSE the client's own.
 */
final class SessionGuard {

	private static final Logger log = LoggerFactory.getLogger("mcpwatch");

	private final Engine engine;

	private final McpServerTransport transport;

	private final Sequencer inbound = new Sequencer();

	private final Sequencer outbound = new Sequencer();

	private final String connectionId = "conn-" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);

	private final AtomicBoolean dropped = new AtomicBoolean();

	private volatile McpServerSession session;

	private volatile String sessionId;

	private volatile McpJsonMapper mapper;

	SessionGuard(Engine engine, McpServerTransport transport) {
		this.engine = engine;
		this.transport = transport;
		this.sessionId = this.connectionId;
	}

	/**
	 * The real session, once the server's factory has built it. Its id is the transport's own, so
	 * an HTTP session is tracked under the id the client will send back.
	 */
	void bind(McpServerSession session) {
		this.session = session;
		String id = session.getId();
		if (id != null && !id.isEmpty() && !id.equals(this.sessionId)) {
			this.engine.renameSession(this.sessionId, id);
			this.sessionId = id;
		}
	}

	String sessionId() {
		return this.sessionId;
	}

	Engine engine() {
		return this.engine;
	}

	/**
	 * The connection has gone: the engine can forget its session state. Only the first call counts —
	 * the transport's {@code close()} and {@code closeGracefully()} may both run for one connection,
	 * and a second drop would be a round trip about a session the engine has already forgotten.
	 */
	void closed() {
		if (this.dropped.compareAndSet(false, true)) {
			this.engine.dropSession(this.sessionId);
		}
	}

	// ---- checks ----------------------------------------------------------------------------------

	/**
	 * A message from the client. Completes with what to pass to the server, or null when the call
	 * was refused and the client has been answered.
	 */
	CompletableFuture<JSONRPCMessage> checkInbound(JSONRPCMessage message) {
		return this.inbound.submit(() -> {
			Map<String, Object> raw = toMap(message);
			if (raw == null) {
				return message; // Can't be represented; the rules get no say, so don't drop it.
			}
			Engine.Outcome outcome = this.engine.fromClient(this.sessionId, raw, null);
			// A blocked call is answered to the client on the raw transport, not the guarded one:
			// the guard's own answer must not be checked again on its way out.
			if (outcome.reply() != null) {
				JSONRPCMessage reply = toMessage(outcome.reply());
				if (reply != null) {
					this.transport.sendMessage(reply).subscribe();
				}
			}
			return same(outcome.forward(), raw) ? message : toMessage(outcome.forward());
		});
	}

	/**
	 * A message from the server. Completes with what to pass to the client, or null when it is
	 * withheld.
	 */
	CompletableFuture<JSONRPCMessage> checkOutbound(JSONRPCMessage message) {
		return this.outbound.submit(() -> {
			Map<String, Object> raw = toMap(message);
			if (raw == null) {
				return message;
			}
			Engine.Outcome outcome = this.engine.fromServer(this.sessionId, raw, false);
			// A reply owed to the server itself (a refused sampling or elicitation request) goes
			// back in as though the client had sent it.
			if (outcome.reply() != null) {
				McpServerSession target = this.session;
				JSONRPCMessage reply = toMessage(outcome.reply());
				if (target != null && reply != null) {
					target.handle(reply).subscribe();
				}
				else {
					log.warn("[mcpwatch] refused {} from the server; it gets no answer here", raw.get("method"));
				}
			}
			return same(outcome.forward(), raw) ? message : toMessage(outcome.forward());
		});
	}

	// ---- conversion ------------------------------------------------------------------------------

	private McpJsonMapper mapper() {
		McpJsonMapper current = this.mapper;
		if (current == null) {
			current = McpJsonDefaults.getMapper();
			this.mapper = current;
		}
		return current;
	}

	/** The SDK's message as plain JSON for the engine, or null when it can't be written. */
	private Map<String, Object> toMap(JSONRPCMessage message) {
		try {
			return Json.parseObject(mapper().writeValueAsString(message));
		}
		catch (IOException | RuntimeException e) {
			log.warn("[mcpwatch] could not read a message for checking: {}", e.toString());
			return null;
		}
	}

	/** Plain JSON back into an SDK message, or null when it can't be read. */
	private JSONRPCMessage toMessage(Map<String, Object> raw) {
		if (raw == null) {
			return null;
		}
		try {
			return McpSchema.deserializeJsonRpcMessage(mapper(), Json.write(raw));
		}
		catch (IOException | RuntimeException e) {
			log.warn("[mcpwatch] could not rebuild a checked message: {}", e.toString());
			return null;
		}
	}

	/** True when the guard passed the message through untouched, so the original object can be reused. */
	private static boolean same(Map<String, Object> forward, Map<String, Object> original) {
		return forward != null && forward.equals(original);
	}
}
