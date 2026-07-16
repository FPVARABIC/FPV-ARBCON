export type TransportDataListener = (data: Uint8Array) => void;

export type TransportDisconnectListener = (reason?: unknown) => void;

export type TransportErrorListener = (error: unknown) => void;

export type TransportUnsubscribe = () => void;

export interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  send(data: Uint8Array): Promise<void>;
  onData(listener: TransportDataListener): TransportUnsubscribe;
  onDisconnect(listener: TransportDisconnectListener): TransportUnsubscribe;
  onError(listener: TransportErrorListener): TransportUnsubscribe;
}
