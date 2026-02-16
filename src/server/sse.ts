/**
 * SSE (Server-Sent Events) Broadcaster for Treliq
 *
 * Provides real-time updates to connected dashboard clients.
 * No additional dependencies — uses native HTTP streaming via Fastify reply.
 */

import type { FastifyReply } from 'fastify';

export type SSEEvent = 'scan_start' | 'scan_complete' | 'pr_scored' | 'pr_closed';

export class SSEBroadcaster {
  private clients = new Set<FastifyReply>();

  /**
   * Register a new SSE client connection.
   * Sets appropriate headers and handles cleanup on disconnect.
   */
  addClient(reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial connection event
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

    this.clients.add(reply);

    // Clean up on disconnect
    reply.raw.on('close', () => {
      this.clients.delete(reply);
    });
  }

  /**
   * Broadcast an event to all connected clients.
   */
  broadcast(event: SSEEvent, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of this.clients) {
      try {
        client.raw.write(payload);
      } catch {
        // Client disconnected — remove
        this.clients.delete(client);
      }
    }
  }

  /**
   * Send a keepalive ping to all clients (prevents proxy timeouts).
   */
  ping(): void {
    const payload = `: keepalive ${new Date().toISOString()}\n\n`;
    for (const client of this.clients) {
      try {
        client.raw.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Number of connected clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Close all client connections.
   */
  closeAll(): void {
    for (const client of this.clients) {
      try {
        client.raw.end();
      } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}
