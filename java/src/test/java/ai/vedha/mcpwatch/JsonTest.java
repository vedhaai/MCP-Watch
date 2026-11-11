package ai.vedha.mcpwatch;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The guard brings no JSON library of its own, so this codec is load-bearing: everything it gets
 * wrong, the guard gets wrong. It also reads hostile input by design.
 */
class JsonTest {

	@Test
	@DisplayName("a JSON-RPC message survives a round trip unchanged")
	void roundTrip() {
		String message = "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\","
				+ "\"params\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.txt\",\"lines\":[1,2,3]}}}";
		Map<String, Object> parsed = Json.parseObject(message);
		assertEquals("2.0", parsed.get("jsonrpc"));
		assertEquals(7L, parsed.get("id"));
		assertEquals(message, Json.write(parsed), "key order and values must be preserved");
	}

	@Test
	@DisplayName("whole numbers stay whole, so a JSON-RPC id still matches")
	void numbers() {
		Map<String, Object> parsed = Json.parseObject("{\"id\":1,\"big\":9007199254740993,\"ratio\":1.5,\"exp\":2e3}");
		assertEquals(1L, parsed.get("id"));
		assertEquals(9007199254740993L, parsed.get("big"), "a long must not be rounded through a double");
		assertEquals(1.5, parsed.get("ratio"));
		assertEquals(2000.0, parsed.get("exp"));
		assertTrue(Json.write(parsed).startsWith("{\"id\":1,"), "an integer id must not come back as 1.0");
	}

	@Test
	@DisplayName("negative and zero values parse")
	void signs() {
		List<Object> values = Json.asArray(Json.parse("[-1,0,-2.5,1e-3]"));
		assertEquals(List.of(-1L, 0L, -2.5, 0.001), values);
	}

	@Test
	@DisplayName("escapes and unicode survive both ways")
	void escapes() {
		Map<String, Object> parsed = Json.parseObject("{\"s\":\"a\\\"b\\\\c\\nd\\u00e9\\u0001\"}");
		assertEquals("a\"b\\c\nd\u00e9\u0001", parsed.get("s"));
		// A control character must be escaped on the way out or the line protocol breaks.
		assertEquals("{\"s\":\"a\\\"b\\\\c\\nd\u00e9\\u0001\"}", Json.write(parsed));
	}

	@Test
	@DisplayName("a tab or newline inside a string never ends the line sent to the engine")
	void noRawNewlines() {
		String written = Json.write(Map.of("s", "one\ntwo\tthree\r"));
		assertFalse(written.contains("\n"), "a newline in a value would split the engine's line protocol");
		assertFalse(written.contains("\r"));
		assertEquals("one\ntwo\tthree\r", Json.parseObject(written).get("s"));
	}

	@Test
	@DisplayName("empty containers and literals")
	void empties() {
		assertEquals(Map.of(), Json.parse("{}"));
		assertEquals(List.of(), Json.parse("[]"));
		assertNull(Json.parse("null"));
		assertEquals(Boolean.TRUE, Json.parse(" true "));
		assertEquals("{}", Json.write(Map.of()));
		assertEquals("[]", Json.write(List.of()));
	}

	@Test
	@DisplayName("nulls inside objects and arrays are kept")
	void nullsInside() {
		Map<String, Object> parsed = Json.parseObject("{\"a\":null,\"b\":[null,1]}");
		assertTrue(parsed.containsKey("a"));
		assertNull(parsed.get("a"));
		assertEquals("{\"a\":null,\"b\":[null,1]}", Json.write(parsed));
	}

	@Test
	@DisplayName("nesting past the limit is refused rather than overflowing the stack")
	void depthLimit() {
		String deep = "[".repeat(Json.MAX_DEPTH + 10) + "]".repeat(Json.MAX_DEPTH + 10);
		assertThrows(Json.JsonException.class, () -> Json.parse(deep));
		// The guard must survive it: parseOrNull is what reads untrusted bodies.
		assertNull(Json.parseOrNull(deep));
	}

	@Test
	@DisplayName("broken input is refused, not guessed at")
	void broken() {
		for (String bad : List.of("{", "{\"a\"}", "{\"a\":}", "[1,]", "[1 2]", "\"unterminated", "{\"a\":1}x", "",
				"tru", "{\"a\":\"\\q\"}", "{\"a\":\"\\u00\"}")) {
			assertThrows(Json.JsonException.class, () -> Json.parse(bad), "should refuse: " + bad);
		}
	}

	@Test
	@DisplayName("a body that isn't JSON comes back as null instead of throwing")
	void parseOrNull() {
		assertNull(Json.parseOrNull("not json"));
		assertNull(Json.parseObject("[1,2]"), "an array is not an object");
		assertNull(Json.parseObject("not json"));
		assertEquals(Map.of("a", 1L), Json.parseObject("{\"a\":1}"));
	}

	@Test
	@DisplayName("asObject and asArray only accept their own shape")
	void shapes() {
		assertNull(Json.asObject(List.of()));
		assertNull(Json.asArray(Map.of()));
		assertNull(Json.asObject(null));
		Map<String, Object> object = new LinkedHashMap<>();
		assertSame(object, Json.asObject(object));
	}

	@Test
	@DisplayName("values JSON cannot hold are written as null rather than breaking the line")
	void nonFinite() {
		assertEquals("{\"a\":null}", Json.write(Map.of("a", Double.NaN)));
		assertEquals("{\"a\":null}", Json.write(Map.of("a", Double.POSITIVE_INFINITY)));
	}

	@Test
	@DisplayName("whitespace between every token is allowed")
	void whitespace() {
		assertEquals(Map.of("a", List.of(1L)), Json.parse(" { \"a\" : [ 1 ] } "));
	}

	@Test
	@DisplayName("slightly off numbers are read, because refusing one would skip the whole message")
	void lenientNumbersAreDeliberate() {
		// A body the parser refuses is handed to the application unchecked, so being stricter than
		// the application's own parser would be a way past the guard. Pinned so nobody "corrects"
		// this into a bypass; see the note on Json.Parser.number().
		assertEquals(5L, Json.parse("+5"));
		assertEquals(1L, Json.parse("01"));
		assertEquals(0.5, Json.parse(".5"));
		assertEquals(Map.of("id", 1L), Json.parse("{\"id\":01}"));

		// Rubbish that holds no number at all is still refused.
		for (String bad : List.of("1.2.3", "--1", "1e", "1-2", "-", "+")) {
			assertThrows(Json.JsonException.class, () -> Json.parse(bad), "should refuse: " + bad);
		}
	}

	@Test
	@DisplayName("an array holding a null is written, not thrown over")
	void arrayWithNull() {
		// A JSON null is an ordinary value, and an engine request is assembled from arrays the
		// caller supplies; refusing one would take the guard down instead of the message.
		assertEquals("[null]", Json.write(new Object[] { null }));
		assertEquals("[1,null,\"a\"]", Json.write(new Object[] { 1, null, "a" }));
		assertEquals("[null]", Json.write(java.util.Collections.singletonList(null)));
		Map<String, Object> message = new LinkedHashMap<>();
		message.put("id", null);
		assertEquals("{\"id\":null}", Json.write(message));
	}

	@Test
	@DisplayName("a half surrogate survives the trip to the engine instead of becoming a question mark")
	void loneSurrogate() {
		// Written raw it is not encodable in UTF-8 and reaches the engine as "?", so the rules would
		// judge a different string from the one the application goes on to see.
		String parsed = (String) Json.parse("\"\\ud83d\"");
		String written = Json.write(parsed);
		assertEquals("\"\\ud83d\"", written);
		String overTheWire = new String(written.getBytes(java.nio.charset.StandardCharsets.UTF_8),
				java.nio.charset.StandardCharsets.UTF_8);
		assertEquals(parsed, Json.parse(overTheWire), "the engine must see the string the guard read");

		// A real pair is still a character, and stays one.
		String pair = (String) Json.parse("\"\\ud83d\\ude00\"");
		assertEquals(2, pair.length());
		assertEquals(pair, Json.parse(Json.write(pair)));
		assertTrue(Json.write(pair).contains("\uD83D\uDE00"), "a whole emoji needs no escaping");
	}
}
