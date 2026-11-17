using System;
using System.Collections.Generic;
using Vedhaai.MCPWatch;
using Xunit;

namespace Vedhaai.MCPWatch.Tests
{
    public class JsonTests
    {
        [Fact]
        public void RoundTripsObjectsArraysAndScalars()
        {
            const string text = "{\"a\":1,\"b\":[true,false,null,\"x\"],\"c\":{\"d\":-2.5}}";
            var parsed = Json.ParseObject(text);
            Assert.Equal(1L, parsed["a"]);
            Assert.Equal(text, Json.Write(parsed));
        }

        [Fact]
        public void IdsKeepTheirType()
        {
            Assert.Equal(7L, Json.ParseObject("{\"id\":7}")["id"]);
            Assert.Equal("abc", Json.ParseObject("{\"id\":\"abc\"}")["id"]);
            Assert.Equal(9007199254740993L, Json.ParseObject("{\"id\":9007199254740993}")["id"]);
        }

        [Fact]
        public void OutputIsAlwaysOneLine()
        {
            var json = Json.Write(new Dictionary<string, object> { ["t"] = "a\nb\r\nc\u2028d\u0001" });
            Assert.DoesNotContain("\n", json);
            Assert.DoesNotContain("\r", json);
            Assert.DoesNotContain("\u2028", json);
            Assert.Equal("a\nb\r\nc\u2028d\u0001", Json.ParseObject(json)["t"]);
        }

        [Fact]
        public void KeepsUnicodeAndEscapesALoneSurrogate()
        {
            var smile = "x\U0001F600y";
            Assert.Equal(smile, Json.ParseObject(Json.Write(new Dictionary<string, object> { ["t"] = smile }))["t"]);

            var lone = "a\ud800b";
            var written = Json.Write(new Dictionary<string, object> { ["t"] = lone });
            Assert.Contains("\\ud800", written);
            Assert.Equal(lone, Json.ParseObject(written)["t"]);
        }

        [Theory]
        [InlineData("")]
        [InlineData("{")]
        [InlineData("{\"a\":}")]
        [InlineData("{\"a\":1,}")]
        [InlineData("[1,]")]
        [InlineData("{\"a\":01}")]
        [InlineData("{\"a\":\"\u0001\"}")]
        [InlineData("{\"a\":1} extra")]
        [InlineData("{'a':1}")]
        [InlineData("{\"a\":\"\\q\"}")]
        public void MalformedInputIsRefused(string text)
        {
            Assert.Null(Json.ParseObject(text));
        }

        [Fact]
        public void NonObjectIsNotAnObject()
        {
            Assert.Null(Json.ParseObject("[1,2]"));
            Assert.Null(Json.ParseObject("\"s\""));
            Assert.Null(Json.ParseObject("null"));
        }

        [Fact]
        public void HostileNestingIsRefusedNotAStackOverflow()
        {
            var deep = new string('[', 100000) + new string(']', 100000);
            Assert.Throws<FormatException>(() => Json.Parse(deep));
        }
    }
}
