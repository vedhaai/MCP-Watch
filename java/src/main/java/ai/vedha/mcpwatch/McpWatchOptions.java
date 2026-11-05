package ai.vedha.mcpwatch;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Settings for one guarded server, as the Node middleware's options.
 *
 * <p>Everything is optional. What you leave out comes from the {@code MCPWATCH_*} environment
 * variables, which the engine reads itself, exactly as for a Node or Python server. With a project
 * key, the project's settings in the dashboard win over both, and reach the guard within 5 seconds.
 *
 * <pre>{@code
 * McpWatchOptions.builder()
 *     .projectKey("mw_...")
 *     .mode("enforce")
 *     .denyTools("run_command")
 *     .build();
 * }</pre>
 */
public final class McpWatchOptions {

	private final Map<String, Object> engineOptions;

	private final Boolean enabled;

	private final List<String> engineCommand;

	private final Duration startTimeout;

	private final Duration callTimeout;

	private McpWatchOptions(Builder b) {
		this.engineOptions = new LinkedHashMap<>(b.engineOptions);
		this.enabled = b.enabled;
		this.engineCommand = b.engineCommand == null ? null : List.copyOf(b.engineCommand);
		this.startTimeout = b.startTimeout;
		this.callTimeout = b.callTimeout;
	}

	/** Options with nothing set: everything comes from the environment and the dashboard. */
	public static McpWatchOptions defaults() {
		return builder().build();
	}

	public static Builder builder() {
		return new Builder();
	}

	/**
	 * Whether the guard runs at all. {@code MCPWATCH_ENABLED=0} turns it off, so a server can be
	 * started unguarded without touching its code.
	 */
	public boolean isEnabled() {
		if (this.enabled != null) {
			return this.enabled;
		}
		return !"0".equals(System.getenv("MCPWATCH_ENABLED"));
	}

	/** True when the guard passes messages through if the engine can't be reached (the default). */
	public boolean isFailOpen() {
		Object value = this.engineOptions.get("failOpen");
		return !(value instanceof Boolean) || (Boolean) value;
	}

	List<String> engineCommand() {
		return this.engineCommand;
	}

	Duration startTimeout() {
		return this.startTimeout == null ? Duration.ofSeconds(120) : this.startTimeout;
	}

	Duration callTimeout() {
		return this.callTimeout == null ? Duration.ofSeconds(60) : this.callTimeout;
	}

	/** The options as the engine's {@code MCPWATCH_ENGINE_OPTIONS} payload. */
	Map<String, Object> toEngineOptions(String name) {
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("name", name);
		out.putAll(this.engineOptions);
		return out;
	}

	/** The mode asked for in code or the environment, before the engine reports its own. */
	String requestedMode() {
		Object mode = this.engineOptions.get("mode");
		if (mode instanceof String && !((String) mode).isEmpty()) {
			return (String) mode;
		}
		String fromEnv = System.getenv("MCPWATCH_MODE");
		return fromEnv == null || fromEnv.isEmpty() ? "enforce" : fromEnv;
	}

	public static final class Builder {

		private final Map<String, Object> engineOptions = new LinkedHashMap<>();

		private Boolean enabled;

		private List<String> engineCommand;

		private Duration startTimeout;

		private Duration callTimeout;

		private Builder() {
		}

		/** The project key from the dashboard: events go to that project and its settings apply live. */
		public Builder projectKey(String key) {
			return put("key", key);
		}

		/** The dashboard URL (default {@code http://127.0.0.1:9100}). */
		public Builder server(String url) {
			return put("server", url);
		}

		/** {@code off}, {@code observe}, {@code protect} or {@code enforce}. */
		public Builder mode(String mode) {
			return put("mode", mode);
		}

		/** False turns the guard off: the server runs untouched. */
		public Builder enabled(boolean enabled) {
			this.enabled = enabled;
			return this;
		}

		/**
		 * What to do when the engine can't be reached: true (the default) passes messages through,
		 * false refuses requests with a JSON-RPC error.
		 */
		public Builder failOpen(boolean failOpen) {
			return put("failOpen", failOpen);
		}

		public Builder denyTools(String... tools) {
			return put("denyTools", List.of(tools));
		}

		public Builder allowTools(String... tools) {
			return put("allowTools", List.of(tools));
		}

		/** HTTP: the web origins allowed to call the server. Others are refused (MW030). */
		public Builder allowedOrigins(String... origins) {
			return put("allowedOrigins", List.of(origins));
		}

		/** HTTP: the host names the server answers to (default: not checked). */
		public Builder allowedHosts(String... hosts) {
			return put("allowedHosts", List.of(hosts));
		}

		/** HTTP: refuse requests with no {@code Authorization} or {@code X-API-Key} header (MW031). */
		public Builder requireAuth(boolean requireAuth) {
			return put("requireAuth", requireAuth);
		}

		/** HTTP: refuse JWT bearer tokens whose {@code aud} doesn't include this (MW036). */
		public Builder expectedAudience(String audience) {
			return put("expectedAudience", audience);
		}

		public Builder windowSeconds(int seconds) {
			return put("windowSeconds", seconds);
		}

		public Builder throttleAt(int score) {
			return put("throttleAt", score);
		}

		public Builder blockAt(int score) {
			return put("blockAt", score);
		}

		public Builder maxCallsPerWindow(int calls) {
			return put("maxCallsPerWindow", calls);
		}

		public Builder maxArgBytes(int bytes) {
			return put("maxArgBytes", bytes);
		}

		public Builder maxResultBytes(int bytes) {
			return put("maxResultBytes", bytes);
		}

		public Builder eventsFile(String path) {
			return put("eventsFile", path);
		}

		public Builder pinsFile(String path) {
			return put("pinsFile", path);
		}

		public Builder registryFile(String path) {
			return put("registryFile", path);
		}

		/** Turns the AI reviewer on with its defaults (local Ollama, {@code qwen2.5:7b}). */
		public Builder ai(boolean enabled) {
			return ai(Map.of("enabled", enabled));
		}

		/** The AI reviewer's settings: {@code enabled}, {@code url}, {@code model}, {@code apiKey}, … */
		public Builder ai(Map<String, Object> ai) {
			return put("ai", new LinkedHashMap<>(ai));
		}

		/** Clients to block or always allow, overriding the rules in every mode. */
		public Builder clients(List<String> block, List<String> allow) {
			Map<String, Object> clients = new LinkedHashMap<>();
			clients.put("block", List.copyOf(block));
			clients.put("allow", List.copyOf(allow));
			return put("clients", clients);
		}

		/**
		 * How to start the engine, when it isn't {@code mcpwatch} on the PATH and
		 * {@code MCPWATCH_ENGINE} isn't set. The {@code engine} argument is added for you.
		 */
		public Builder engineCommand(String... command) {
			this.engineCommand = new ArrayList<>(List.of(command));
			return this;
		}

		/** How long to wait for the engine to start. The first run may fetch it with npx. */
		public Builder startTimeout(Duration timeout) {
			this.startTimeout = timeout;
			return this;
		}

		/** How long to wait for one message to be checked. */
		public Builder callTimeout(Duration timeout) {
			this.callTimeout = timeout;
			return this;
		}

		/** Any option the engine takes, by its own name, for settings this builder has no method for. */
		public Builder option(String name, Object value) {
			return put(name, value);
		}

		private Builder put(String name, Object value) {
			if (value != null) {
				this.engineOptions.put(name, value);
			}
			return this;
		}

		public McpWatchOptions build() {
			return new McpWatchOptions(this);
		}
	}
}
