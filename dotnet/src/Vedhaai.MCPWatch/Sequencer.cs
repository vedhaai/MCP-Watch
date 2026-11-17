using System;
using System.Threading.Tasks;

namespace Vedhaai.MCPWatch
{
    /// <summary>
    /// Runs the guard's checks one at a time, in the order they were handed in.
    ///
    /// A slow check (the AI reviewer can take about a second) must never let a later message overtake
    /// an earlier one on the same connection: a <c>tools/list</c> that overtakes its own
    /// <c>initialize</c> would be judged without the session state it depends on. Each direction of
    /// each session gets its own sequencer, which is the .NET form of the promise queue the Node and
    /// Python guards keep and the <c>Sequencer</c> the Java guard keeps.
    /// </summary>
    internal sealed class Sequencer
    {
        private readonly object _lock = new object();
        private Task _tail = Task.CompletedTask;

        /// <summary>Queues <paramref name="work"/> behind everything already queued here.</summary>
        public Task<T> Submit<T>(Func<Task<T>> work)
        {
            lock (_lock)
            {
                var next = _tail.ContinueWith(_ => work(), TaskScheduler.Default).Unwrap();
                // A failed check must not wedge the queue: the next message still runs.
                _tail = next.ContinueWith(_ => { }, TaskScheduler.Default);
                return next;
            }
        }
    }
}
