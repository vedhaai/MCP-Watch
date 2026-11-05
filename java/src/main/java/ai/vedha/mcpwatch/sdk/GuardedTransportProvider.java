package ai.vedha.mcpwatch.sdk;

import java.util.List;

import ai.vedha.mcpwatch.Engine;
import io.modelcontextprotocol.spec.McpServerSession;
import io.modelcontextprotocol.spec.McpServerTransportProvider;
import reactor.core.publisher.Mono;

/**
 * Your transport provider with the guard in front of it.
 *
 * <p>Hand this to {@code McpServer.sync(...)} or {@code McpServer.async(...)} in place of the
 * provider you built. It makes no decisions itself: when the server registers its session factory,
 * this wraps each new connection's transport and session so that both directions pass through the
 * engine.
 *
 * <p>Get one from {@link McpWatch#guard}.
 */
public final class GuardedTransportProvider implements McpServerTransportProvider {

	private final McpServerTransportProvider delegate;

	private final Engine engine;

	GuardedTransportProvider(McpServerTransportProvider delegate, Engine engine) {
		this.delegate = delegate;
		this.engine = engine;
	}

	/** The engine checking this server's messages. */
	public Engine engine() {
		return this.engine;
	}

	/** The mode in force: {@code off}, {@code observe}, {@code protect} or {@code enforce}. */
	public String mode() {
		return this.engine.mode();
	}

	/** Changes the mode at runtime; {@code off} passes everything through. */
	public void setMode(String mode) {
		this.engine.setMode(mode);
	}

	@Override
	public void setSessionFactory(McpServerSession.Factory sessionFactory) {
		this.delegate.setSessionFactory(transport -> {
			SessionGuard guard = new SessionGuard(this.engine, transport);
			// The server builds its session on the guarded transport, so everything it writes is
			// checked; the session it hands back is wrapped so everything it reads is too.
			McpServerSession session = sessionFactory.create(new GuardedServerTransport(transport, guard));
			guard.bind(session);
			return new GuardedServerSession(session, guard, transport);
		});
	}

	@Override
	public Mono<Void> notifyClients(String method, Object params) {
		return this.delegate.notifyClients(method, params);
	}

	@Override
	public Mono<Void> notifyClient(String sessionId, String method, Object params) {
		return this.delegate.notifyClient(sessionId, method, params);
	}

	@Override
	public Mono<Void> closeGracefully() {
		return this.delegate.closeGracefully().doFinally(signal -> this.engine.close());
	}

	@Override
	public void close() {
		try {
			this.delegate.close();
		}
		finally {
			this.engine.close();
		}
	}

	@Override
	public List<String> protocolVersions() {
		return this.delegate.protocolVersions();
	}
}
