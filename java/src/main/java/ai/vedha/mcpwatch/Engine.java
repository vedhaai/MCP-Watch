package ai.vedha.mcpwatch;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The MCPWatch engine, run as a Node sidecar ({@code mcpwatch engine}).
 *
 * <p>Every rule, the AI reviewer and the dashboard reporting live in the Node package; this class
 * starts it as a child process and asks it about each JSON-RPC message, one JSON object per line
 * each way. Java guards stay thin, and a server in Java gets exactly the verdicts a Node server
 * would. This is the Java twin of {@code mcpwatch/engine.py}.
 *
 * <p>One engine per guarded server, shared by every connection to it. Thread-safe.
 *
 * <p>Checks never throw: if the engine can't be reached, a request is refused with
 * {@code -32001} (the default), or passed on unchanged when {@code failOpen} is set.
 */
public final class Engine implements AutoCloseable {

	private static final Logger log = LoggerFactory.getLogger("mcpwatch");

	/** The JSON-RPC error code for a message the guard refused. */
	public static final int BLOCKED = -32001;

	static final String NPM_PACKAGE = "@vedhaai/mcpwatch";

	/** What to pass on (possibly changed, or null to drop it) and what to answer the sender with. */
	public record Outcome(Map<String, Object> forward, Map<String, Object> reply) {

		static Outcome pass(Map<String, Object> message) {
			return new Outcome(message, null);
		}
	}

	private final String name;

	private final McpWatchOptions options;

	private final Map<String, Object> engineOptions;

	private final AtomicLong ids = new AtomicLong();

	/**
	 * What is waiting on the engine that is running now. Each start gets a fresh map, so a crashed
	 * engine's reader thread can only ever fail the calls that were made to <i>it</i>: it must not
	 * cancel the handshake or the messages already queued against its replacement.
	 */
	private volatile Map<Long, CompletableFuture<Map<String, Object>>> pending = new ConcurrentHashMap<>();

	/**
	 * Held to start the engine and to write one request to it, so lines never interleave on the pipe.
	 *
	 * <p>A {@link ReentrantLock} rather than {@code synchronized} so that waiting for it can be given
	 * up on: a restart waits for the engine's handshake, which may take the whole start timeout, and
	 * every message arriving meanwhile would otherwise block for exactly as long. A guard that stops
	 * answering is worse than one that refuses — a caller that cannot get in now fails, and
	 * {@code failOpen} decides what that means, the same as any other engine failure.
	 */
	private final ReentrantLock lock = new ReentrantLock();

	private volatile Process process;

	private Writer toEngine;

	private long lastStart;

	/**
	 * Not under {@link #lock}: a thread whose check already failed must not queue behind a start.
	 *
	 * <p>Started a full window in the past because {@code nanoTime()} has an arbitrary origin and may
	 * be negative; from a plain zero the very first guard error would be swallowed, which is the one
	 * that matters most.
	 */
	private final AtomicLong lastWarning = new AtomicLong(System.nanoTime() - TimeUnit.SECONDS.toNanos(61));

	private volatile boolean closed;

	private volatile String mode;

	public Engine(String name, McpWatchOptions options) {
		this.name = name;
		this.options = options;
		this.engineOptions = options.toEngineOptions(name);
		this.mode = options.requestedMode();
	}

	/**
	 * The engine for one guarded server, started, or {@code null} when MCPWatch is off
	 * ({@code enabled(false)} or {@code MCPWATCH_ENABLED=0}).
	 *
	 * <p>A guard that can't start its engine is not an error the caller has to handle: it is logged,
	 * and {@code failOpen} decides what happens to messages until the engine comes up.
	 */
	public static Engine createIfEnabled(String name, McpWatchOptions options) {
		McpWatchOptions settings = options == null ? McpWatchOptions.defaults() : options;
		if (!settings.isEnabled()) {
			return null;
		}
		Engine engine = new Engine(name, settings);
		try {
			engine.start();
		}
		catch (EngineUnavailableException e) {
			String what = settings.isFailOpen() ? "messages pass unchecked" : "requests are refused";
			log.error("[mcpwatch] {}; {} until it starts", e.getMessage(), what);
		}
		return engine;
	}

	public String name() {
		return this.name;
	}

	/** The mode the engine reported, which with a project key is the dashboard's. */
	public String mode() {
		return this.mode;
	}

	// ---- process ---------------------------------------------------------------------------------

	/**
	 * How to start the engine: the given command, {@code MCPWATCH_ENGINE}, {@code mcpwatch} on the
	 * PATH, else npx.
	 */
	static List<String> engineCommand(List<String> configured) {
		List<String> command = configured;
		if (command == null || command.isEmpty()) {
			String fromEnv = System.getenv("MCPWATCH_ENGINE");
			if (fromEnv != null && !fromEnv.isBlank()) {
				command = splitCommand(fromEnv);
			}
		}
		if (command != null && !command.isEmpty()) {
			List<String> out = new ArrayList<>(command);
			out.add("engine");
			return out;
		}
		String found = onPath("mcpwatch");
		if (found != null) {
			return List.of(found, "engine");
		}
		String npx = onPath("npx");
		if (npx != null) {
			return List.of(npx, "-y", NPM_PACKAGE, "engine");
		}
		throw new EngineUnavailableException(
				"Node.js 20+ is needed: install it, then `npm install -g " + NPM_PACKAGE + "`");
	}

	/** Splits a command line on spaces, keeping quoted paths whole. Backslashes are left alone. */
	static List<String> splitCommand(String command) {
		List<String> out = new ArrayList<>();
		StringBuilder current = new StringBuilder();
		char quote = 0;
		boolean any = false;
		for (int i = 0; i < command.length(); i++) {
			char c = command.charAt(i);
			if (quote != 0) {
				if (c == quote) {
					quote = 0;
				}
				else {
					current.append(c);
				}
			}
			else if (c == '"' || c == '\'') {
				quote = c;
				any = true;
			}
			else if (Character.isWhitespace(c)) {
				if (any || current.length() > 0) {
					out.add(current.toString());
					current.setLength(0);
					any = false;
				}
			}
			else {
				current.append(c);
			}
		}
		if (any || current.length() > 0) {
			out.add(current.toString());
		}
		return out;
	}

	private static String onPath(String program) {
		String path = System.getenv("PATH");
		if (path == null) {
			return null;
		}
		boolean windows = System.getProperty("os.name", "").toLowerCase().startsWith("windows");
		List<String> names = windows ? List.of(program + ".cmd", program + ".exe", program + ".bat", program)
				: List.of(program);
		for (String dir : path.split(File.pathSeparator)) {
			if (dir.isEmpty()) {
				continue;
			}
			for (String candidate : names) {
				File file = new File(dir, candidate);
				if (file.isFile() && file.canExecute()) {
					return file.getAbsolutePath();
				}
			}
		}
		return null;
	}

	/** Starts the engine now rather than on the first message (that one would wait for it). */
	public void start() {
		this.lock.lock();
		try {
			ensureStarted();
		}
		finally {
			this.lock.unlock();
		}
	}

	private Process ensureStarted() {
		if (this.closed) {
			throw new EngineUnavailableException("the guard has been closed");
		}
		if (this.process != null) {
			if (this.process.isAlive()) {
				return this.process;
			}
			// Don't respawn a crashing engine on every message.
			if (System.nanoTime() - this.lastStart < TimeUnit.SECONDS.toNanos(10)) {
				throw new EngineUnavailableException("the engine stopped; retrying shortly");
			}
		}
		this.lastStart = System.nanoTime();
		List<String> command = engineCommand(this.options.engineCommand());
		ProcessBuilder builder = new ProcessBuilder(command);
		builder.environment().put("MCPWATCH_ENGINE_OPTIONS", Json.write(this.engineOptions));
		// The engine logs to stderr; let it reach the host application's own stderr.
		builder.redirectError(ProcessBuilder.Redirect.INHERIT);
		Process started;
		try {
			started = builder.start();
		}
		catch (IOException e) {
			throw new EngineUnavailableException("could not start " + command.get(0) + ": " + e.getMessage(), e);
		}

		// Anything still waiting belonged to the engine that just died. It gets its own map, so
		// nothing registered against the new engine below can be caught up in failing it.
		Map<Long, CompletableFuture<Map<String, Object>>> dead = this.pending;
		Map<Long, CompletableFuture<Map<String, Object>>> fresh = new ConcurrentHashMap<>();
		this.pending = fresh;
		failPending(dead, new EngineUnavailableException("the engine was restarted"));
		CompletableFuture<Map<String, Object>> ready = new CompletableFuture<>();
		fresh.put(0L, ready);
		this.process = started;
		this.toEngine = new OutputStreamWriter(started.getOutputStream(), StandardCharsets.UTF_8);

		Thread reader = new Thread(() -> read(started, fresh), "mcpwatch-engine");
		reader.setDaemon(true);
		reader.start();

		try {
			Map<String, Object> hello = ready.get(this.options.startTimeout().toMillis(), TimeUnit.MILLISECONDS);
			Object reported = hello.get("mode");
			if (reported instanceof String) {
				this.mode = (String) reported;
			}
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			started.destroyForcibly();
			throw new EngineUnavailableException("interrupted while the engine started", e);
		}
		catch (ExecutionException | TimeoutException e) {
			started.destroyForcibly();
			throw new EngineUnavailableException("the engine did not start: " + e, e);
		}
		return started;
	}

	/** One engine's output, answering only the calls made to that same engine. */
	private void read(Process process, Map<Long, CompletableFuture<Map<String, Object>>> waiting) {
		try (BufferedReader lines = new BufferedReader(
				new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
			String line;
			while ((line = lines.readLine()) != null) {
				Map<String, Object> answer = Json.parseObject(line);
				if (answer == null) {
					continue;
				}
				Object id = answer.get("id");
				if (id instanceof Number) {
					CompletableFuture<Map<String, Object>> call = waiting.remove(((Number) id).longValue());
					if (call != null) {
						call.complete(answer);
					}
				}
			}
		}
		catch (IOException e) {
			// The pipe closed; everything waiting is told below.
		}
		int code;
		try {
			code = process.waitFor();
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			code = -1;
		}
		failPending(waiting, new EngineUnavailableException("the engine exited (code " + code + ")"));
	}

	private static void failPending(Map<Long, CompletableFuture<Map<String, Object>>> waiting, RuntimeException cause) {
		for (Long id : List.copyOf(waiting.keySet())) {
			CompletableFuture<Map<String, Object>> call = waiting.remove(id);
			if (call != null) {
				call.completeExceptionally(cause);
			}
		}
	}

	private CompletableFuture<Map<String, Object>> send(String op, Map<String, Object> fields) {
		long waitMs = this.options.callTimeout().toMillis();
		boolean held;
		try {
			held = this.lock.tryLock(waitMs, TimeUnit.MILLISECONDS);
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new EngineUnavailableException("interrupted while waiting for the engine", e);
		}
		if (!held) {
			// Another thread is starting the engine and is taking longer than this caller is willing
			// to wait for an answer at all.
			throw new EngineUnavailableException("the engine was busy for " + waitMs + " ms");
		}
		try {
			ensureStarted();
			long id = this.ids.incrementAndGet();
			Map<String, Object> request = new LinkedHashMap<>();
			request.put("id", id);
			request.put("op", op);
			request.putAll(fields);
			CompletableFuture<Map<String, Object>> answer = new CompletableFuture<>();
			Map<Long, CompletableFuture<Map<String, Object>>> waiting = this.pending;
			waiting.put(id, answer);
			try {
				this.toEngine.write(Json.write(request));
				this.toEngine.write("\n");
				this.toEngine.flush();
			}
			catch (IOException e) {
				waiting.remove(id);
				throw new EngineUnavailableException("the engine stopped: " + e.getMessage(), e);
			}
			return answer;
		}
		finally {
			this.lock.unlock();
		}
	}

	/** One request to the engine, waited for. Throws when it can't be reached or answers an error. */
	public Map<String, Object> call(String op, Map<String, Object> fields) {
		try {
			Map<String, Object> answer = send(op, fields).get(this.options.callTimeout().toMillis(),
					TimeUnit.MILLISECONDS);
			if (answer.containsKey("error") && !answer.containsKey("forward")) {
				throw new EngineUnavailableException(String.valueOf(answer.get("error")));
			}
			return answer;
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new EngineUnavailableException("interrupted while checking a message", e);
		}
		catch (ExecutionException e) {
			Throwable cause = e.getCause() == null ? e : e.getCause();
			throw new EngineUnavailableException(cause.getMessage(), cause);
		}
		catch (TimeoutException e) {
			throw new EngineUnavailableException("the engine did not answer in "
					+ this.options.callTimeout().toMillis() + " ms", e);
		}
	}

	/**
	 * Lets the engine send its queued events and exit.
	 *
	 * <p>Closing its stdin is what tells the engine to flush, and that needs the lock. If a start is
	 * in flight and will not give the lock up promptly, shutting the host application down matters
	 * more than those last queued events, so the engine is simply killed.
	 */
	@Override
	public void close() {
		this.closed = true;
		boolean held;
		try {
			held = this.lock.tryLock(5, TimeUnit.SECONDS);
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			held = false;
		}
		Process running = this.process;
		if (running == null || !running.isAlive()) {
			if (held) {
				this.lock.unlock();
			}
			return;
		}
		if (!held) {
			running.destroyForcibly();
			return;
		}
		try {
			this.toEngine.close();
		}
		catch (IOException e) {
			// Closing the pipe is what tells the engine to flush; it may already be gone.
		}
		finally {
			this.lock.unlock();
		}
		try {
			if (!running.waitFor(5, TimeUnit.SECONDS)) {
				running.destroyForcibly();
			}
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			running.destroyForcibly();
		}
	}

	// ---- checks ----------------------------------------------------------------------------------

	private Outcome failed(Map<String, Object> message, RuntimeException cause) {
		long now = System.nanoTime();
		long last = this.lastWarning.get();
		// No lock: a check that has already failed must not then wait on a start that may take the
		// whole start timeout, and losing a race here only costs one duplicate log line.
		if (now - last > TimeUnit.SECONDS.toNanos(60) && this.lastWarning.compareAndSet(last, now)) {
			log.error("[mcpwatch] guard error: {}", cause.getMessage());
		}
		boolean isRequest = message != null && message.get("id") != null && message.get("method") != null;
		if (this.options.isFailOpen() || !isRequest) {
			return Outcome.pass(message);
		}
		Map<String, Object> error = new LinkedHashMap<>();
		error.put("code", BLOCKED);
		error.put("message", "MCPWatch failed closed");
		Map<String, Object> reply = new LinkedHashMap<>();
		reply.put("jsonrpc", "2.0");
		reply.put("id", message.get("id"));
		reply.put("error", error);
		return new Outcome(null, reply);
	}

	/** Checks a message on its way from the client to the server. */
	public Outcome fromClient(String session, Map<String, Object> message, Map<String, Object> http) {
		Map<String, Object> fields = new LinkedHashMap<>();
		fields.put("session", session);
		fields.put("msg", message);
		if (http != null) {
			fields.put("http", http);
		}
		try {
			return outcome(call("client", fields));
		}
		catch (RuntimeException e) {
			return failed(message, e);
		}
	}

	/** Checks a message on its way from the server to the client. */
	public Outcome fromServer(String session, Map<String, Object> message, boolean strict) {
		Map<String, Object> fields = new LinkedHashMap<>();
		fields.put("session", session);
		fields.put("msg", message);
		fields.put("strict", strict);
		try {
			return outcome(call("server", fields));
		}
		catch (RuntimeException e) {
			return failed(message, e);
		}
	}

	/** True when a request with no JSON-RPC body (GET, DELETE) must be refused. */
	public boolean fromHttp(String session, Map<String, Object> http, String method) {
		Map<String, Object> fields = new LinkedHashMap<>();
		fields.put("session", session);
		fields.put("http", http);
		fields.put("method", method);
		try {
			return Boolean.TRUE.equals(call("http", fields).get("refuse"));
		}
		catch (RuntimeException e) {
			failed(null, e);
			return !this.options.isFailOpen();
		}
	}

	/** Session bookkeeping (rename, drop, eventId) that nobody waits for. */
	public void note(String op, Map<String, Object> fields) {
		try {
			send(op, fields);
		}
		catch (RuntimeException e) {
			failed(null, e);
		}
	}

	public void renameSession(String from, String to) {
		Map<String, Object> fields = new LinkedHashMap<>();
		fields.put("from", from);
		fields.put("to", to);
		note("rename", fields);
	}

	public void dropSession(String session) {
		note("drop", Map.of("session", session));
	}

	public void noteEventId(String session, String eventId) {
		Map<String, Object> fields = new LinkedHashMap<>();
		fields.put("session", session);
		fields.put("eventId", eventId);
		note("eventId", fields);
	}

	/** Changes the mode at runtime; {@code off} passes everything through. */
	public void setMode(String mode) {
		Object reported = call("mode", Map.of("mode", mode)).get("mode");
		this.mode = reported instanceof String ? (String) reported : mode;
	}

	private static Outcome outcome(Map<String, Object> answer) {
		return new Outcome(Json.asObject(answer.get("forward")), Json.asObject(answer.get("reply")));
	}
}
