import { Socket, createConnection } from 'net';
import { EventEmitter } from 'events';

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const COMMAND_TIMEOUT_MS = 2_000;

export interface TelnetEvents {
  /** Fires when the socket transitions from disconnected to connected. */
  connected: [];
  /** Fires when the socket goes from connected to disconnected (any cause). */
  disconnected: [reason: string];
  /** Fires when an unexpected line arrives (not the response to a pending command). */
  asyncLine: [line: string];
}

/**
 * Long-lived Liquidsoap telnet connection. Reconnects with exponential
 * backoff. One pending command at a time — caller should serialise
 * higher-level batches.
 */
export class TelnetClient extends EventEmitter {
  private socket: Socket | null = null;
  private connected = false;
  private buffer = '';
  private pending: {
    resolve: (lines: string[]) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    accumulator: string[];
  } | null = null;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private host: string,
    private port: number,
    private logger?: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    super();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
    }
    this.socket = createConnection({ host: this.host, port: this.port });

    this.socket.on('connect', () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_INITIAL_MS;
      this.emit('connected');
      this.logger?.info(`Telnet connected to ${this.host}:${this.port}`);
    });
    this.socket.on('data', (chunk) => this.handleData(chunk));
    this.socket.on('error', (err) => this.handleClose(`error: ${err.message}`));
    this.socket.on('close', () => this.handleClose('closed'));
  }

  private handleClose(reason: string): void {
    if (this.connected) {
      this.connected = false;
      this.emit('disconnected', reason);
      this.logger?.warn(`Telnet disconnected (${reason})`);
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new Error(`Telnet disconnected mid-command: ${reason}`));
    }
    this.buffer = '';
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    while (true) {
      const newlineIdx = this.buffer.indexOf('\n');
      if (newlineIdx === -1) break;
      const line = this.buffer.slice(0, newlineIdx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (this.pending) {
      // Liquidsoap's telnet ends a response block with the literal "END" line.
      if (line === 'END') {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(p.accumulator);
        return;
      }
      this.pending.accumulator.push(line);
      return;
    }
    if (line.length === 0) return;
    this.emit('asyncLine', line);
  }

  /**
   * Send a single command, return the response lines (between the command
   * and the trailing "END" sentinel).
   */
  async command(cmd: string): Promise<string[]> {
    if (!this.connected || !this.socket) {
      throw new Error('Telnet not connected');
    }
    if (this.pending) {
      throw new Error('Telnet busy (one command at a time)');
    }
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          reject(new Error(`Telnet command timed out: ${cmd}`));
        }
      }, COMMAND_TIMEOUT_MS);
      this.pending = { resolve, reject, timer, accumulator: [] };
      this.socket!.write(cmd + '\n');
    });
  }
}
