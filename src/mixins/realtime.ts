import { FbnsClient, FbnsDeviceAuth, RealtimeClient } from '../realtime';
import type { MQTToTTransport, RealtimeHandler } from '../realtime/mqttot';
import type { Client } from '../client';

export class RealtimeMixin {
  realtimeClient(this: Client, transport: MQTToTTransport | null = null): RealtimeClient {
    return new RealtimeClient(this, transport);
  }

  async realtimeConnect(this: Client, transport: MQTToTTransport | null = null): Promise<RealtimeClient> {
    if (!this.realtime) this.realtime = this.realtimeClient(transport);
    else if (transport !== null) this.realtime.transport = transport;
    await this.realtime.connect();
    return this.realtime;
  }

  async realtimeDisconnect(this: Client): Promise<void> {
    if (this.realtime) {
      await this.realtime.disconnect();
      this.realtime = null;
    }
  }

  realtimeOn(this: Client, event: string, handler: RealtimeHandler): void {
    if (!this.realtime) this.realtime = this.realtimeClient();
    this.realtime.on(event, handler);
  }

  async realtimeReadOnce(this: Client): Promise<any> {
    if (!this.realtime) throw new Error('Realtime client is not connected');
    return this.realtime.readOnce();
  }

  async realtimePing(this: Client): Promise<boolean> {
    if (!this.realtime) throw new Error('Realtime client is not connected');
    return this.realtime.ping();
  }

  fbnsClient(this: Client, transport: MQTToTTransport | null = null, auth: FbnsDeviceAuth | null = null): FbnsClient {
    return new FbnsClient(this, transport, auth);
  }

  async fbnsConnect(
    this: Client,
    transport: MQTToTTransport | null = null,
    auth: FbnsDeviceAuth | null = null,
    register = true,
  ): Promise<FbnsClient> {
    if (!this.fbns) this.fbns = this.fbnsClient(transport, auth);
    else {
      if (transport !== null) this.fbns.transport = transport;
      if (auth !== null) this.fbns.auth = auth;
    }
    await this.fbns.connect(register);
    return this.fbns;
  }

  async fbnsDisconnect(this: Client): Promise<void> {
    if (this.fbns) {
      try {
        await this.fbns.disconnect();
      } finally {
        this.fbns = null;
      }
    }
  }

  fbnsOn(this: Client, event: string, handler: RealtimeHandler): void {
    if (!this.fbns) this.fbns = this.fbnsClient();
    this.fbns.on(event, handler);
  }

  async fbnsReadOnce(this: Client): Promise<any> {
    if (!this.fbns) throw new Error('FBNS client is not connected');
    return this.fbns.readOnce();
  }

  async fbnsPing(this: Client): Promise<boolean> {
    if (!this.fbns) throw new Error('FBNS client is not connected');
    return this.fbns.ping();
  }
}
