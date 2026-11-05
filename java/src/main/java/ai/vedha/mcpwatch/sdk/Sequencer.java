package ai.vedha.mcpwatch.sdk;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/**
 * Runs the guard's checks off the caller's thread, one at a time, in the order they were handed in.
 *
 * <p>A check is a blocking round trip to the engine, and with the AI reviewer on it can take about
 * a second. Two things follow. It must not run on a transport or event-loop thread, and a slow
 * review must never let a later message overtake an earlier one on the same connection: a
 * {@code tools/list} that overtakes its own {@code initialize} would be judged without the session
 * state it depends on. Each direction of each session gets its own sequencer, which is the Java
 * form of the promise queue the Node and Python guards keep.
 */
final class Sequencer {

	private static final ThreadFactory THREADS = new ThreadFactory() {

		private final AtomicLong count = new AtomicLong();

		@Override
		public Thread newThread(Runnable runnable) {
			Thread thread = new Thread(runnable, "mcpwatch-guard-" + this.count.incrementAndGet());
			// Never hold up the host application's shutdown.
			thread.setDaemon(true);
			return thread;
		}
	};

	/** Shared by every session: checks block on a pipe, so threads are cheap and mostly idle. */
	private static final Executor POOL = Executors.newCachedThreadPool(THREADS);

	private final Object lock = new Object();

	private CompletableFuture<?> tail = CompletableFuture.completedFuture(null);

	/** Queues {@code work} behind everything already queued here. */
	<T> CompletableFuture<T> submit(Supplier<T> work) {
		synchronized (this.lock) {
			CompletableFuture<T> next = this.tail.thenApplyAsync(ignored -> work.get(), POOL);
			// A failed check must not wedge the queue: the next message still runs.
			this.tail = next.handle((result, error) -> null);
			return next;
		}
	}
}
