package ai.vedha.mcpwatch.http;

import java.util.Map;

/** What the guard decided about one HTTP request, before the application sees it. */
public final class RequestCheck {

	private String session;

	private final boolean strict;

	private final String method;

	private final Map<String, String> headers;

	private boolean refuse;

	private byte[] reply;

	private byte[] body;

	private boolean changed;

	RequestCheck(String session, boolean strict, String method, Map<String, String> headers, byte[] body) {
		this.session = session;
		this.strict = strict;
		this.method = method;
		this.headers = headers;
		this.body = body;
	}

	/** The session this request belongs to: its MCP session id, else the caller's address. */
	public String session() {
		return this.session;
	}

	void setSession(String session) {
		this.session = session;
	}

	/**
	 * The request carried a session id, so a server message answering nothing the client asked for
	 * is forged or replayed (MW037).
	 */
	public boolean strict() {
		return this.strict;
	}

	public String method() {
		return this.method;
	}

	public Map<String, String> headers() {
		return this.headers;
	}

	/** Answer 403 without passing the request on (a GET or DELETE refused by the transport rules). */
	public boolean refuse() {
		return this.refuse;
	}

	void setRefuse(boolean refuse) {
		this.refuse = refuse;
	}

	/** JSON to answer the POST with ourselves (blocked calls); the application never sees it. */
	public byte[] reply() {
		return this.reply;
	}

	void setReply(byte[] reply) {
		this.reply = reply;
	}

	/** The body to pass on, possibly with messages changed. */
	public byte[] body() {
		return this.body;
	}

	void setBody(byte[] body) {
		this.body = body;
		this.changed = true;
	}

	/** True when the guard rewrote the body. */
	public boolean changed() {
		return this.changed;
	}
}
