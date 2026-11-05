package ai.vedha.mcpwatch.http;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import ai.vedha.mcpwatch.Engine;
import ai.vedha.mcpwatch.McpWatchOptions;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.FilterConfig;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Guards the MCP endpoint of any servlet application: Spring Boot MVC, Quarkus, Jetty, Tomcat.
 *
 * <p>This is the Java twin of the Python {@code McpWatchWSGI} middleware. Registered in front of
 * your MCP endpoint, it checks every client message in a POST body before the application sees it,
 * and every server message on the way back, whether the response is JSON or an SSE stream.
 *
 * <p>In Spring Boot:
 *
 * <pre>{@code
 * @Bean
 * FilterRegistrationBean<McpWatchFilter> mcpwatch() {
 *     var filter = new McpWatchFilter("my-tools",
 *             McpWatchOptions.builder().projectKey("mw_...").build(), "/mcp");
 *     var registration = new FilterRegistrationBean<>(filter);
 *     registration.addUrlPatterns("/mcp/*");
 *     registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
 *     return registration;
 * }
 * }</pre>
 *
 * <p>Or in {@code web.xml} / {@code @WebFilter}, with {@code projectKey}, {@code mode},
 * {@code path} and {@code name} as init parameters.
 *
 * <p><b>One limit.</b> When the guard refuses a request the <i>server</i> sent the client (a
 * sampling or elicitation request, MW026 / MW029), the servlet API gives no way to hand the server
 * an answer: the request is dropped and logged, and the server sees it time out. Servers that send
 * those are better guarded with {@code McpWatch.guard(provider)} on the SDK transport.
 */
public class McpWatchFilter implements Filter {

	private static final Logger log = LoggerFactory.getLogger("mcpwatch");

	private String name;

	private McpWatchOptions options;

	private List<String> paths;

	private Engine engine;

	private HttpGuard guard;

	private boolean ownsEngine = true;

	/** For {@code web.xml} and {@code @WebFilter}: everything comes from the init parameters. */
	public McpWatchFilter() {
		this("mcp-server", null, "/mcp");
	}

	public McpWatchFilter(String name, McpWatchOptions options, String... paths) {
		this.name = name;
		this.options = options;
		this.paths = List.of(paths);
	}

	/** Guards with an engine you already have, for sharing one between a filter and an SDK server. */
	public McpWatchFilter(Engine engine, String... paths) {
		this.name = engine == null ? "mcp-server" : engine.name();
		this.engine = engine;
		this.paths = List.of(paths);
		this.ownsEngine = false;
		this.guard = engine == null ? null : new HttpGuard(engine, this.paths);
	}

	@Override
	public void init(FilterConfig config) {
		if (this.guard != null) {
			return;
		}
		if (config != null) {
			this.name = param(config, "name", this.name);
			String path = param(config, "path", null);
			if (path != null) {
				List<String> parsed = new ArrayList<>();
				for (String part : path.split(",")) {
					if (!part.isBlank()) {
						parsed.add(part.trim());
					}
				}
				this.paths = parsed;
			}
			this.options = fromInitParameters(config, this.options);
		}
		this.engine = Engine.createIfEnabled(this.name, this.options);
		this.guard = this.engine == null ? null : new HttpGuard(this.engine, this.paths);
		if (this.engine != null) {
			log.warn("[mcpwatch] guarding \"{}\"", this.name);
		}
	}

	private static String param(FilterConfig config, String name, String fallback) {
		String value = config.getInitParameter(name);
		return value == null || value.isBlank() ? fallback : value.trim();
	}

	private static McpWatchOptions fromInitParameters(FilterConfig config, McpWatchOptions given) {
		if (given != null) {
			return given;
		}
		McpWatchOptions.Builder builder = McpWatchOptions.builder();
		String key = param(config, "projectKey", null);
		if (key != null) {
			builder.projectKey(key);
		}
		String server = param(config, "server", null);
		if (server != null) {
			builder.server(server);
		}
		String mode = param(config, "mode", null);
		if (mode != null) {
			builder.mode(mode);
		}
		String denyTools = param(config, "denyTools", null);
		if (denyTools != null) {
			builder.denyTools(denyTools.split("\\s*,\\s*"));
		}
		String failOpen = param(config, "failOpen", null);
		if (failOpen != null) {
			builder.failOpen(Boolean.parseBoolean(failOpen));
		}
		String enabled = param(config, "enabled", null);
		if (enabled != null) {
			builder.enabled(Boolean.parseBoolean(enabled));
		}
		return builder.build();
	}

	/** The engine this filter guards with, or null when MCPWatch is off. */
	public Engine engine() {
		return this.engine;
	}

	@Override
	public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
			throws IOException, ServletException {
		if (this.guard == null || !(request instanceof HttpServletRequest)
				|| !(response instanceof HttpServletResponse)) {
			chain.doFilter(request, response);
			return;
		}
		HttpServletRequest http = (HttpServletRequest) request;
		HttpServletResponse out = (HttpServletResponse) response;
		String path = http.getRequestURI();
		String context = http.getContextPath();
		if (context != null && !context.isEmpty() && path.startsWith(context)) {
			path = path.substring(context.length());
		}
		if (!this.guard.matches(path)) {
			chain.doFilter(request, response);
			return;
		}

		byte[] body = "POST".equalsIgnoreCase(http.getMethod()) ? readBody(http) : new byte[0];
		RequestCheck check = this.guard.checkRequest(http.getMethod(), headersOf(http), body, http.getRemoteAddr(),
				http.isSecure());

		if (check.refuse()) {
			out.setStatus(HttpServletResponse.SC_FORBIDDEN);
			out.setContentType("text/plain; charset=utf-8");
			out.getOutputStream().write("Refused by MCPWatch".getBytes(StandardCharsets.UTF_8));
			return;
		}
		if (check.reply() != null) {
			out.setStatus(HttpServletResponse.SC_OK);
			out.setContentType("application/json");
			out.setContentLength(check.reply().length);
			out.getOutputStream().write(check.reply());
			return;
		}

		GuardedResponse guarded = new GuardedResponse(out, this.guard, check);
		try {
			chain.doFilter(new GuardedRequest(http, check.body()), guarded);
			guarded.finish();
		}
		finally {
			this.guard.finished(check);
		}
	}

	@Override
	public void destroy() {
		if (this.ownsEngine && this.engine != null) {
			this.engine.close();
		}
	}

	private static byte[] readBody(HttpServletRequest request) throws IOException {
		try (InputStream in = request.getInputStream()) {
			return in.readAllBytes();
		}
	}

	private static Map<String, String> headersOf(HttpServletRequest request) {
		Map<String, String> out = new LinkedHashMap<>();
		Enumeration<String> names = request.getHeaderNames();
		if (names == null) {
			return out;
		}
		while (names.hasMoreElements()) {
			String name = names.nextElement();
			out.put(name, request.getHeader(name));
		}
		return out;
	}

	// ---- the request the application sees: the body the guard approved ----------------------------

	private static final class GuardedRequest extends HttpServletRequestWrapper {

		private final byte[] body;

		GuardedRequest(HttpServletRequest request, byte[] body) {
			super(request);
			this.body = body;
		}

		@Override
		public ServletInputStream getInputStream() {
			ByteArrayInputStream source = new ByteArrayInputStream(this.body);
			return new ServletInputStream() {

				@Override
				public int read() {
					return source.read();
				}

				@Override
				public int read(byte[] b, int off, int len) {
					return source.read(b, off, len);
				}

				@Override
				public int available() {
					return source.available();
				}

				@Override
				public boolean isFinished() {
					return source.available() == 0;
				}

				@Override
				public boolean isReady() {
					return true;
				}

				@Override
				public void setReadListener(ReadListener listener) {
					throw new UnsupportedOperationException("MCPWatch reads the MCP request body itself");
				}
			};
		}

		@Override
		public java.io.BufferedReader getReader() {
			String encoding = getCharacterEncoding();
			java.nio.charset.Charset charset = encoding == null ? StandardCharsets.UTF_8
					: java.nio.charset.Charset.forName(encoding);
			return new java.io.BufferedReader(new java.io.InputStreamReader(new ByteArrayInputStream(this.body),
					charset));
		}

		@Override
		public int getContentLength() {
			return this.body.length;
		}

		@Override
		public long getContentLengthLong() {
			return this.body.length;
		}

		@Override
		public String getHeader(String name) {
			if ("content-length".equalsIgnoreCase(name)) {
				return String.valueOf(this.body.length);
			}
			return super.getHeader(name);
		}

		@Override
		public Enumeration<String> getHeaders(String name) {
			if ("content-length".equalsIgnoreCase(name)) {
				return Collections.enumeration(List.of(String.valueOf(this.body.length)));
			}
			return super.getHeaders(name);
		}
	}

	// ---- the response the application writes into: checked on its way out -------------------------

	private static final class GuardedResponse extends HttpServletResponseWrapper {

		private final HttpGuard guard;

		private final RequestCheck check;

		private GuardedStream stream;

		private PrintWriter writer;

		GuardedResponse(HttpServletResponse response, HttpGuard guard, RequestCheck check) {
			super(response);
			this.guard = guard;
			this.check = check;
		}

		@Override
		public ServletOutputStream getOutputStream() throws IOException {
			if (this.writer != null) {
				throw new IllegalStateException("getWriter() was already called");
			}
			if (this.stream == null) {
				this.stream = new GuardedStream(this, this.guard, this.check);
			}
			return this.stream;
		}

		@Override
		public PrintWriter getWriter() throws IOException {
			if (this.writer == null) {
				if (this.stream == null) {
					this.stream = new GuardedStream(this, this.guard, this.check);
				}
				String encoding = getCharacterEncoding();
				this.writer = new PrintWriter(new OutputStreamWriter(this.stream,
						encoding == null ? StandardCharsets.UTF_8.name() : encoding), false);
			}
			return this.writer;
		}

		/**
		 * The guard decides the length of a JSON body, so the application's own
		 * {@code Content-Length} is dropped. SSE has none to begin with.
		 */
		@Override
		public void setContentLength(int length) {
			// Set in finish(), once the checked body is known.
		}

		@Override
		public void setContentLengthLong(long length) {
			// Set in finish(), once the checked body is known.
		}

		@Override
		public void flushBuffer() throws IOException {
			if (this.writer != null) {
				this.writer.flush();
			}
			if (this.stream != null) {
				this.stream.flush();
			}
		}

		@Override
		public void reset() {
			super.reset();
			this.stream = null;
			this.writer = null;
		}

		void finish() throws IOException {
			if (this.writer != null) {
				this.writer.flush();
			}
			if (this.stream != null) {
				this.stream.finish();
			}
		}

		Map<String, String> headers() {
			Map<String, String> out = new LinkedHashMap<>();
			for (String name : getHeaderNames()) {
				out.put(name, getHeader(name));
			}
			String contentType = getContentType();
			if (contentType != null) {
				out.put("content-type", contentType);
			}
			return out;
		}

		void setRealContentLength(int length) {
			super.setContentLength(length);
		}
	}

	/**
	 * Sends the application's bytes through the guard. A JSON body is held until it is complete and
	 * can be parsed; an SSE stream goes out event by event, so the client keeps streaming.
	 */
	private static final class GuardedStream extends ServletOutputStream {

		private final GuardedResponse response;

		private final HttpGuard guard;

		private final RequestCheck check;

		private ServletOutputStream delegate;

		private ResponseFilter filter;

		private ByteArrayOutputStream buffered;

		private boolean finished;

		GuardedStream(GuardedResponse response, HttpGuard guard, RequestCheck check) {
			this.response = response;
			this.guard = guard;
			this.check = check;
		}

		/** The filter can only be built once the application has set its content type. */
		private ResponseFilter filter() throws IOException {
			if (this.filter == null) {
				this.delegate = ((HttpServletResponse) this.response.getResponse()).getOutputStream();
				this.filter = this.guard.response(this.check, this.response.headers(), null);
				if (this.filter.kind() == ResponseFilter.Kind.JSON) {
					this.buffered = new ByteArrayOutputStream();
				}
			}
			return this.filter;
		}

		@Override
		public void write(int b) throws IOException {
			write(new byte[] { (byte) b }, 0, 1);
		}

		@Override
		public void write(byte[] bytes, int off, int len) throws IOException {
			if (this.finished || len <= 0) {
				return;
			}
			ResponseFilter active = filter();
			if (active.kind() == ResponseFilter.Kind.JSON) {
				this.buffered.write(bytes, off, len);
				return;
			}
			byte[] chunk = new byte[len];
			System.arraycopy(bytes, off, chunk, 0, len);
			if (active.kind() == ResponseFilter.Kind.SSE) {
				byte[] out = active.feed(chunk);
				if (out.length > 0) {
					this.delegate.write(out);
					this.delegate.flush();
				}
				return;
			}
			this.delegate.write(chunk);
		}

		@Override
		public void flush() throws IOException {
			// A JSON body can only be judged whole, so flushing must not let half of it out.
			if (this.delegate != null && this.filter != null && this.filter.kind() != ResponseFilter.Kind.JSON) {
				this.delegate.flush();
			}
		}

		void finish() throws IOException {
			if (this.finished) {
				return;
			}
			this.finished = true;
			if (this.filter == null) {
				return; // The application wrote nothing.
			}
			if (this.filter.kind() == ResponseFilter.Kind.JSON) {
				byte[] checked = this.filter.json(this.buffered.toByteArray());
				this.response.setRealContentLength(checked.length);
				this.delegate.write(checked);
			}
			else if (this.filter.kind() == ResponseFilter.Kind.SSE) {
				byte[] rest = this.filter.end();
				if (rest.length > 0) {
					this.delegate.write(rest);
				}
			}
			this.delegate.flush();
		}

		@Override
		public void close() throws IOException {
			finish();
		}

		@Override
		public boolean isReady() {
			try {
				return this.delegate == null || this.delegate.isReady();
			}
			catch (RuntimeException e) {
				return true;
			}
		}

		@Override
		public void setWriteListener(WriteListener listener) {
			throw new UnsupportedOperationException("MCPWatch checks the MCP response as it is written");
		}
	}
}
