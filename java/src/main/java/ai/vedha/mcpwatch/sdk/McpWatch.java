package ai.vedha.mcpwatch.sdk;

import ai.vedha.mcpwatch.Engine;
import ai.vedha.mcpwatch.McpWatchOptions;
import io.modelcontextprotocol.spec.McpServerTransportProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Guards a server built with the official MCP Java SDK: every message between any client and it is
 * checked by MCPWatch.
 *
 * <pre>{@code
 * var transport = new StdioServerTransportProvider();
 * var server = McpServer.sync(McpWatch.guard(transport))   // the only line changed
 *     .serverInfo("my-tools", "1.0.0")
 *     .tools(...)
 *     .build();
 * }</pre>
 *
 * <p>Clients need no changes. Options are those of the Node middleware
 * ({@link McpWatchOptions}); left out, they come from the {@code MCPWATCH_*} environment
 * variables, and with a project key the dashboard's settings win over both.
 *
 * <p>This covers the transports that hand the server one session per connection: <b>stdio</b> and
 * <b>HTTP+SSE</b>. For <b>Streamable HTTP</b>, guard the endpoint with
 * {@link ai.vedha.mcpwatch.http.McpWatchFilter} instead — it sits in the servlet chain, where the
 * request headers the transport rules need (MW030–MW036) are still available.
 */
public final class McpWatch {

	private static final Logger log = LoggerFactory.getLogger("mcpwatch");

	private McpWatch() {
	}

	/** Guards a transport provider, with settings from the environment and the dashboard. */
	public static McpServerTransportProvider guard(McpServerTransportProvider provider) {
		return guard(provider, McpWatchOptions.defaults());
	}

	/** Guards a transport provider. */
	public static McpServerTransportProvider guard(McpServerTransportProvider provider, McpWatchOptions options) {
		return guard("mcp-server", provider, options);
	}

	/**
	 * Guards a transport provider, under a name that identifies this server in the dashboard, in the
	 * shared registry, and in its pinned tool definitions.
	 *
	 * <p>Returns the provider itself when MCPWatch is off ({@code enabled(false)} or
	 * {@code MCPWATCH_ENABLED=0}), so the server runs untouched.
	 */
	public static McpServerTransportProvider guard(String name, McpServerTransportProvider provider,
			McpWatchOptions options) {
		if (provider == null) {
			throw new IllegalArgumentException("A transport provider is required");
		}
		Engine engine = Engine.createIfEnabled(name, options);
		if (engine == null) {
			return provider;
		}
		log.warn("[mcpwatch] guarding \"{}\"", name);
		return new GuardedTransportProvider(provider, engine);
	}
}
