package ai.vedha.mcpwatch.sdk;

import io.modelcontextprotocol.json.TypeRef;
import io.modelcontextprotocol.spec.McpSchema.JSONRPCMessage;
import io.modelcontextprotocol.spec.McpServerTransport;
import reactor.core.publisher.Mono;

/**
 * The transport the server writes into: every message on its way to the client is checked first.
 *
 * <p>This is the server-to-client half of the guard — tool lists, tool results, sampling and
 * elicitation requests. A message the rules withhold never reaches the transport underneath.
 */
final class GuardedServerTransport implements McpServerTransport {

	private final McpServerTransport delegate;

	private final SessionGuard guard;

	GuardedServerTransport(McpServerTransport delegate, SessionGuard guard) {
		this.delegate = delegate;
		this.guard = guard;
	}

	@Override
	public Mono<Void> sendMessage(JSONRPCMessage message) {
		// Deferred, so the check is queued in the order the messages are actually sent.
		return Mono.fromFuture(() -> this.guard.checkOutbound(message)).flatMap(this.delegate::sendMessage).then();
	}

	@Override
	public <T> T unmarshalFrom(Object data, TypeRef<T> typeRef) {
		return this.delegate.unmarshalFrom(data, typeRef);
	}

	@Override
	public Mono<Void> closeGracefully() {
		return this.delegate.closeGracefully().doFinally(signal -> this.guard.closed());
	}

	@Override
	public void close() {
		try {
			this.delegate.close();
		}
		finally {
			this.guard.closed();
		}
	}

	@Override
	public java.util.List<String> protocolVersions() {
		return this.delegate.protocolVersions();
	}
}
