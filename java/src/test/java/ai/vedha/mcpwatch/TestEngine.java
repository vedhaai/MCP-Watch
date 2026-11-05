package ai.vedha.mcpwatch;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Assumptions;

/**
 * Starts the real Node engine for the tests, so they check actual verdicts rather than a stand-in.
 *
 * <p>The engine is this repository's own build ({@code engine/dist/cli.js}). Without it the tests
 * that need verdicts are skipped rather than failed, so the Java package can be built on its own.
 */
public final class TestEngine {

	private TestEngine() {
	}

	/** The engine built in this repository, or empty when it hasn't been built. */
	public static Path engineScript() {
		Path fromModule = Paths.get("..", "engine", "dist", "cli.js").toAbsolutePath().normalize();
		return Files.isRegularFile(fromModule) ? fromModule : null;
	}

	public static void requireEngine() {
		Assumptions.assumeTrue(engineScript() != null,
				"engine/dist/cli.js is missing: run `npm run build -w engine` in the repository root");
	}

	/** An engine in the given mode, writing its events into the test's own temporary files. */
	public static Engine start(String name, String mode, Path tempDir) throws IOException {
		requireEngine();
		return start(name, tempDir, McpWatchOptions.builder().mode(mode));
	}

	public static Engine start(String name, Path tempDir, McpWatchOptions.Builder builder) throws IOException {
		requireEngine();
		Files.createDirectories(tempDir);
		McpWatchOptions options = builder
			// No project key: nothing is reported to a dashboard and nothing is fetched from one.
			.eventsFile(tempDir.resolve("events.jsonl").toString())
			.pinsFile(tempDir.resolve("pins.json").toString())
			.registryFile(tempDir.resolve("registry.json").toString())
			.engineCommand("node", engineScript().toString())
			.startTimeout(Duration.ofSeconds(60))
			.callTimeout(Duration.ofSeconds(30))
			.build();
		Engine engine = new Engine(name, options);
		engine.start();
		return engine;
	}

	// ---- messages ---------------------------------------------------------------------------------

	public static Map<String, Object> request(Object id, String method, Map<String, Object> params) {
		Map<String, Object> message = new LinkedHashMap<>();
		message.put("jsonrpc", "2.0");
		message.put("id", id);
		message.put("method", method);
		message.put("params", params);
		return message;
	}

	public static Map<String, Object> toolCall(Object id, String tool, Map<String, Object> arguments) {
		Map<String, Object> params = new LinkedHashMap<>();
		params.put("name", tool);
		params.put("arguments", arguments);
		return request(id, "tools/call", params);
	}

	public static Map<String, Object> response(Object id, Map<String, Object> result) {
		Map<String, Object> message = new LinkedHashMap<>();
		message.put("jsonrpc", "2.0");
		message.put("id", id);
		message.put("result", result);
		return message;
	}

	/** A text tool result, the shape a server answers {@code tools/call} with. */
	public static Map<String, Object> textResult(Object id, String text) {
		Map<String, Object> content = new LinkedHashMap<>();
		content.put("type", "text");
		content.put("text", text);
		return response(id, Map.of("content", java.util.List.of(content)));
	}

	/** The rule ids in a blocked reply's error data. */
	@SuppressWarnings("unchecked")
	public static java.util.List<Object> rules(Map<String, Object> reply) {
		Map<String, Object> error = (Map<String, Object>) reply.get("error");
		Map<String, Object> data = (Map<String, Object>) error.get("data");
		return (java.util.List<Object>) data.get("rules");
	}

	public static int errorCode(Map<String, Object> reply) {
		Map<?, ?> error = (Map<?, ?>) reply.get("error");
		return ((Number) error.get("code")).intValue();
	}
}
