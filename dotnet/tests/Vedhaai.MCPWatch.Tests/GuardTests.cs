using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Vedhaai.MCPWatch;
using Xunit;

namespace Vedhaai.MCPWatch.Tests
{
    public class GuardTests
    {
        [EngineFact]
        public async Task ALineIsCheckedAndRefusedAsJson()
        {
            using (var engine = TestEngine.Start("enforce", out _))
            using (var guard = new McpWatchGuard(engine))
            {
                var o = await guard.FromClientLineAsync("s1",
                    "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"../../.ssh/id_rsa\"}}}");

                Assert.Null(o.ForwardJson);
                Assert.NotNull(o.ReplyJson);
                Assert.DoesNotContain("\n", o.ReplyJson);
                Assert.Contains("-32001", o.ReplyJson);
            }
        }

        [EngineFact]
        public async Task MessagesOfOneSessionAreCheckedInTheOrderTheyWereSubmitted()
        {
            using (var engine = TestEngine.Start("enforce", out _))
            using (var guard = new McpWatchGuard(engine))
            {
                // Submitted without awaiting in between: each task must still finish in submission order.
                var finished = new List<int>();
                var gate = new object();
                var tasks = Enumerable.Range(1, 30).Select(i =>
                    guard.FromClientAsync("s1", TestEngine.ToolCall(i, "read_file",
                        new Dictionary<string, object> { ["path"] = "notes.txt" }))
                        .ContinueWith(t =>
                        {
                            lock (gate) finished.Add(i);
                            return t.Result;
                        }, TaskContinuationOptions.ExecuteSynchronously)).ToArray();

                await Task.WhenAll(tasks);

                // Only the order is asserted: whether a repeated call is let through is the engine's (replay rule's) business.
                Assert.Equal(Enumerable.Range(1, 30).ToList(), finished);
            }
        }

        [Fact]
        public async Task NonObjectClientLinesNeverReachTheServer()
        {
            using (var guard = new McpWatchGuard("x", new McpWatchOptions
            {
                FailOpen = true,
                EngineCommand = new[] { "definitely-not-a-real-program-mcpwatch" },
            }))
            {
                var garbage = await guard.FromClientLineAsync("s1", "{not json");
                Assert.Null(garbage.Forward);
                Assert.Contains("-32700", garbage.ReplyJson);

                var batch = await guard.FromClientLineAsync("s1", "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}]");
                Assert.Null(batch.Forward);
                Assert.Contains("-32600", batch.ReplyJson);
            }
        }

        [Fact]
        public async Task NonObjectServerLinesAreDropped()
        {
            using (var guard = new McpWatchGuard("x", new McpWatchOptions
            {
                EngineCommand = new[] { "definitely-not-a-real-program-mcpwatch" },
            }))
            {
                var o = await guard.FromServerLineAsync("s1", "oops");
                Assert.Null(o.Forward);
                Assert.Null(o.Reply);
            }
        }
    }
}
