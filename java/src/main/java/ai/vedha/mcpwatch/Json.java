package ai.vedha.mcpwatch;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The JSON codec the guard uses on the wire to the engine and on the MCP bodies it inspects.
 *
 * <p>MCPWatch is injected into somebody else's server, so it brings no JSON library of its own: a
 * Jackson or Gson version forced on the host application is exactly the kind of breakage a security
 * guard must not cause. This is the Java stand-in for Python's {@code json} module.
 *
 * <p>Parsed values are {@link Map} (insertion-ordered), {@link List}, {@link String}, {@link Long}
 * or {@link Double}, {@link Boolean} and {@code null}. Input is hostile by assumption, so nesting is
 * capped at {@link #MAX_DEPTH}; anything deeper is rejected rather than overflowing the stack.
 */
public final class Json {

	/** Nesting past this is refused: a guard must not be crashed by the traffic it inspects. */
	public static final int MAX_DEPTH = 200;

	private Json() {
	}

	/** Thrown for input that isn't JSON, or is nested past {@link #MAX_DEPTH}. */
	public static final class JsonException extends RuntimeException {

		private static final long serialVersionUID = 1L;

		JsonException(String message) {
			super(message);
		}
	}

	// ---- parsing ---------------------------------------------------------------------------------

	/** The value in {@code text}, or throws {@link JsonException}. */
	public static Object parse(String text) {
		Parser parser = new Parser(text);
		parser.skipSpace();
		Object value = parser.value(0);
		parser.skipSpace();
		if (parser.at < parser.text.length()) {
			throw new JsonException("Unexpected content at index " + parser.at);
		}
		return value;
	}

	/** The value in {@code text}, or {@code null} when it isn't JSON. For bodies that may be anything. */
	public static Object parseOrNull(String text) {
		try {
			return parse(text);
		}
		catch (JsonException e) {
			return null;
		}
	}

	/** The object in {@code text}, or {@code null} when it isn't a JSON object. */
	public static Map<String, Object> parseObject(String text) {
		Object value = parseOrNull(text);
		return asObject(value);
	}

	/** {@code value} as a JSON object, or {@code null} when it is anything else. */
	@SuppressWarnings("unchecked")
	public static Map<String, Object> asObject(Object value) {
		return value instanceof Map ? (Map<String, Object>) value : null;
	}

	/** {@code value} as a JSON array, or {@code null} when it is anything else. */
	@SuppressWarnings("unchecked")
	public static List<Object> asArray(Object value) {
		return value instanceof List ? (List<Object>) value : null;
	}

	private static final class Parser {

		private final String text;

		private int at;

		Parser(String text) {
			this.text = text;
		}

		void skipSpace() {
			while (this.at < this.text.length()) {
				char c = this.text.charAt(this.at);
				if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
					return;
				}
				this.at++;
			}
		}

		Object value(int depth) {
			if (depth > MAX_DEPTH) {
				throw new JsonException("Nested deeper than " + MAX_DEPTH);
			}
			if (this.at >= this.text.length()) {
				throw new JsonException("Ended early");
			}
			char c = this.text.charAt(this.at);
			switch (c) {
				case '{':
					return object(depth);
				case '[':
					return array(depth);
				case '"':
					return string();
				case 't':
					return literal("true", Boolean.TRUE);
				case 'f':
					return literal("false", Boolean.FALSE);
				case 'n':
					return literal("null", null);
				default:
					return number();
			}
		}

		private Object literal(String word, Object value) {
			if (!this.text.startsWith(word, this.at)) {
				throw new JsonException("Not a JSON value at index " + this.at);
			}
			this.at += word.length();
			return value;
		}

		private Map<String, Object> object(int depth) {
			this.at++; // {
			Map<String, Object> out = new LinkedHashMap<>();
			skipSpace();
			if (peek() == '}') {
				this.at++;
				return out;
			}
			while (true) {
				skipSpace();
				if (peek() != '"') {
					throw new JsonException("Expected a key at index " + this.at);
				}
				String key = string();
				skipSpace();
				if (peek() != ':') {
					throw new JsonException("Expected ':' at index " + this.at);
				}
				this.at++;
				skipSpace();
				out.put(key, value(depth + 1));
				skipSpace();
				char c = peek();
				this.at++;
				if (c == '}') {
					return out;
				}
				if (c != ',') {
					throw new JsonException("Expected ',' or '}' at index " + (this.at - 1));
				}
			}
		}

		private List<Object> array(int depth) {
			this.at++; // [
			List<Object> out = new ArrayList<>();
			skipSpace();
			if (peek() == ']') {
				this.at++;
				return out;
			}
			while (true) {
				skipSpace();
				out.add(value(depth + 1));
				skipSpace();
				char c = peek();
				this.at++;
				if (c == ']') {
					return out;
				}
				if (c != ',') {
					throw new JsonException("Expected ',' or ']' at index " + (this.at - 1));
				}
			}
		}

		private String string() {
			this.at++; // opening quote
			StringBuilder out = new StringBuilder();
			while (true) {
				if (this.at >= this.text.length()) {
					throw new JsonException("Unterminated string");
				}
				char c = this.text.charAt(this.at++);
				if (c == '"') {
					return out.toString();
				}
				if (c != '\\') {
					// Raw control characters are invalid JSON, but rejecting a message over one would
					// let a server bypass the guard by sending it; keep it and let the rules judge.
					out.append(c);
					continue;
				}
				if (this.at >= this.text.length()) {
					throw new JsonException("Unterminated escape");
				}
				char esc = this.text.charAt(this.at++);
				switch (esc) {
					case '"': out.append('"'); break;
					case '\\': out.append('\\'); break;
					case '/': out.append('/'); break;
					case 'b': out.append('\b'); break;
					case 'f': out.append('\f'); break;
					case 'n': out.append('\n'); break;
					case 'r': out.append('\r'); break;
					case 't': out.append('\t'); break;
					case 'u':
						if (this.at + 4 > this.text.length()) {
							throw new JsonException("Truncated \\u escape");
						}
						String hex = this.text.substring(this.at, this.at + 4);
						try {
							out.append((char) Integer.parseInt(hex, 16));
						}
						catch (NumberFormatException e) {
							throw new JsonException("Bad \\u escape \"" + hex + "\"");
						}
						this.at += 4;
						break;
					default:
						throw new JsonException("Bad escape \\" + esc);
				}
			}
		}

		/**
		 * Deliberately looser than the JSON grammar: {@code +5}, {@code 01} and {@code .5} are read
		 * rather than refused.
		 *
		 * <p>This is a security property, not an oversight. A body this parser rejects is passed to
		 * the application <em>unchecked</em> ("not JSON: not ours to judge"), so every input the
		 * guard refuses to read is an input the rules never see. Being stricter than the
		 * application's own parser would therefore be a way through the guard; being looser only
		 * means judging a message the application will go on to reject itself. Anything genuinely
		 * malformed ({@code 1.2.3}, {@code --1}, {@code 1e}) still throws, because no number can be
		 * recovered from it. Leave this as it is.
		 */
		private Object number() {
			int start = this.at;
			if (peek() == '-' || peek() == '+') {
				this.at++;
			}
			boolean fractional = false;
			while (this.at < this.text.length()) {
				char c = this.text.charAt(this.at);
				if (c >= '0' && c <= '9') {
					this.at++;
				}
				else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
					fractional = true;
					this.at++;
				}
				else {
					break;
				}
			}
			String raw = this.text.substring(start, this.at);
			if (raw.isEmpty() || "-".equals(raw) || "+".equals(raw)) {
				throw new JsonException("Not a JSON value at index " + start);
			}
			try {
				// Whole numbers stay whole: a JSON-RPC id written back as 1.0 would no longer match.
				return fractional ? (Object) Double.valueOf(raw) : (Object) Long.valueOf(raw);
			}
			catch (NumberFormatException e) {
				try {
					return Double.valueOf(raw);
				}
				catch (NumberFormatException e2) {
					throw new JsonException("Bad number \"" + raw + "\"");
				}
			}
		}

		private char peek() {
			if (this.at >= this.text.length()) {
				throw new JsonException("Ended early");
			}
			return this.text.charAt(this.at);
		}
	}

	// ---- writing ---------------------------------------------------------------------------------

	/** {@code value} as JSON text. */
	public static String write(Object value) {
		StringBuilder out = new StringBuilder();
		write(value, out, 0);
		return out.toString();
	}

	private static void write(Object value, StringBuilder out, int depth) {
		if (depth > MAX_DEPTH) {
			throw new JsonException("Nested deeper than " + MAX_DEPTH);
		}
		if (value == null) {
			out.append("null");
		}
		else if (value instanceof Boolean || value instanceof Integer || value instanceof Long
				|| value instanceof Short || value instanceof Byte) {
			out.append(value);
		}
		else if (value instanceof Double || value instanceof Float) {
			double d = ((Number) value).doubleValue();
			// JSON has no NaN or Infinity; null is the only honest thing to write.
			out.append(Double.isFinite(d) ? Double.toString(d) : "null");
		}
		else if (value instanceof Number) {
			out.append(value);
		}
		else if (value instanceof CharSequence || value instanceof Character) {
			writeString(value.toString(), out);
		}
		else if (value instanceof Map) {
			out.append('{');
			boolean first = true;
			for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
				if (!first) {
					out.append(',');
				}
				first = false;
				writeString(String.valueOf(e.getKey()), out);
				out.append(':');
				write(e.getValue(), out, depth + 1);
			}
			out.append('}');
		}
		else if (value instanceof Collection) {
			out.append('[');
			boolean first = true;
			for (Object item : (Collection<?>) value) {
				if (!first) {
					out.append(',');
				}
				first = false;
				write(item, out, depth + 1);
			}
			out.append(']');
		}
		else if (value instanceof Object[]) {
			// Not List.of(array): that rejects a null element, and a null is a JSON value like any other.
			out.append('[');
			boolean first = true;
			for (Object item : (Object[]) value) {
				if (!first) {
					out.append(',');
				}
				first = false;
				write(item, out, depth + 1);
			}
			out.append(']');
		}
		else {
			throw new JsonException("Cannot write a " + value.getClass().getName() + " as JSON");
		}
	}

	private static void writeString(String s, StringBuilder out) {
		out.append('"');
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
				case '"': out.append("\\\""); break;
				case '\\': out.append("\\\\"); break;
				case '\b': out.append("\\b"); break;
				case '\f': out.append("\\f"); break;
				case '\n': out.append("\\n"); break;
				case '\r': out.append("\\r"); break;
				case '\t': out.append("\\t"); break;
				default:
					// An unpaired surrogate is not a character UTF-8 can carry: writing it raw turns it
					// into "?" on the wire, so the engine would judge a different string from the one the
					// application ends up seeing. Escaped, it survives the round trip intact.
					if (c < 0x20 || (Character.isHighSurrogate(c) && !(i + 1 < s.length()
							&& Character.isLowSurrogate(s.charAt(i + 1)))) || (Character.isLowSurrogate(c)
									&& !(i > 0 && Character.isHighSurrogate(s.charAt(i - 1))))) {
						out.append(String.format("\\u%04x", (int) c));
					}
					else {
						out.append(c);
					}
			}
		}
		out.append('"');
	}
}
