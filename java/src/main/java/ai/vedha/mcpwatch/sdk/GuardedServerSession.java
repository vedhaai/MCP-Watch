package ai.vedha.mcpwatch.sdk;

import java.time.Duration;
import java.util.Map;

import io.modelcontextprotocol.json.TypeRef;
import io.modelcontextprotocol.spec.McpSchema;
import io.modelcontextprotocol.spec.McpSchema.JSONRPCMessage;
import io.modelcontextprotocol.spec.McpServerSession;
import io.modelcontextprotocol.spec.McpServerTransport;
import reactor.core.publisher.Mono;

/**
 * The session the transport provider feeds: every message from the client is checked before the
 * server's handlers see it.
 *
 * <p>This is the client-to-server half of the guard — tool calls, resource reads and prompts. A
 * call the rules refuse never reaches your tool; the client gets a JSON-RPC error instead.
 *
 * <p>{@link McpServerSession} is a class rather than an interface, so this is a delegating
 * subclass: the superclass is built with empty handlers that are never reached, and every public
 * method is answered by the real session the server's own factory made.
 */
final class GuardedServerSession extends McpServerSession {

	private final McpServerSession delegate;

	private final SessionGuard guard;

	GuardedServerSession(McpServerSession delegate, SessionGuard guard, McpServerTransport transport) {
		// Nothing of the superclass's own state is ever used: every method below delegates.
		super(delegate.getId(), Duration.ofSeconds(1), transport, null, Map.of(), Map.of());
		this.delegate = delegate;
		this.guard = guard;
	}

	@Override
	public Mono<Void> handle(JSONRPCMessage message) {
		// Deferred, so the check is queued in the order the messages actually arrive.
		return Mono.fromFuture(() -> this.guard.checkInbound(message)).flatMap(this.delegate::handle).then();
	}

	@Override
	public String getId() {
		return this.delegate.getId();
	}

	@Override
	public void init(McpSchema.ClientCapabilities clientCapabilities, McpSchema.Implementation clientInfo) {
		this.delegate.init(clientCapabilities, clientInfo);
	}

	@Override
	public void setMinLoggingLevel(McpSchema.LoggingLevel minLoggingLevel) {
		this.delegate.setMinLoggingLevel(minLoggingLevel);
	}

	@Override
	public boolean isNotificationForLevelAllowed(McpSchema.LoggingLevel loggingLevel) {
		return this.delegate.isNotificationForLevelAllowed(loggingLevel);
	}

	/** Server-to-client requests go out through the guarded transport, so they are checked there. */
	@Override
	public <T> Mono<T> sendRequest(String method, Object requestParams, TypeRef<T> typeRef) {
		return this.delegate.sendRequest(method, requestParams, typeRef);
	}

	@Override
	public Mono<Void> sendNotification(String method, Object params) {
		return this.delegate.sendNotification(method, params);
	}

	@Override
	public Mono<Void> closeGracefully() {
		return this.delegate.closeGracefully();
	}

	@Override
	public void close() {
		this.delegate.close();
	}
}
