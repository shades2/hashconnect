import { Event } from "ts-typed-events";
import { IRelay, WebSocketRelay } from "./types/relay";
import { MessageUtil, MessageHandler, MessageTypes, RelayMessage, RelayMessageType } from "./message"
import { HashConnectTypes, IHashConnect, HashConnectConnectionState } from "./types/hashconnect";
import { HashConnectProvider } from "./provider/provider";
import { HashConnectSigner } from "./provider/signer";
global.Buffer = global.Buffer || require('buffer').Buffer;

/**
 * Main interface with hashpack
 */
export class HashConnect implements IHashConnect {

    relay: IRelay;

    // events
    foundExtensionEvent: Event<HashConnectTypes.WalletMetadata>;
    pairingEvent: Event<MessageTypes.ApprovePairing>;
    transactionEvent: Event<MessageTypes.Transaction>;
    acknowledgeMessageEvent: Event<MessageTypes.Acknowledge>;
    additionalAccountRequestEvent: Event<MessageTypes.AdditionalAccountRequest>;
    connectionStatusChange: Event<HashConnectConnectionState>;
    authRequestEvent: Event<MessageTypes.AuthenticationRequest>;
    
    transactionResolver: (value: MessageTypes.TransactionResponse | PromiseLike<MessageTypes.TransactionResponse>) => void;
    additionalAccountResolver: (value: MessageTypes.AdditionalAccountResponse | PromiseLike<MessageTypes.AdditionalAccountResponse>) => void;
    authResolver: (value: MessageTypes.AuthenticationResponse | PromiseLike<MessageTypes.AuthenticationResponse>) => void;

    // messages util
    messageParser: MessageHandler;
    messages: MessageUtil;
    private metadata!: HashConnectTypes.AppMetadata | HashConnectTypes.WalletMetadata;

    publicKeys: Record<string, string> = {};
    private privateKey: string;

    debug: boolean = false;

    constructor(debug?: boolean) {
        this.relay = new WebSocketRelay(this);

        this.foundExtensionEvent = new Event<HashConnectTypes.WalletMetadata>();
        this.pairingEvent = new Event<MessageTypes.ApprovePairing>();
        this.transactionEvent = new Event<MessageTypes.Transaction>();
        this.acknowledgeMessageEvent = new Event<MessageTypes.Acknowledge>();
        this.additionalAccountRequestEvent = new Event<MessageTypes.AdditionalAccountRequest>();
        this.connectionStatusChange = new Event<HashConnectConnectionState>();
        this.authRequestEvent = new Event<MessageTypes.AuthenticationRequest>();
        
        this.messages = new MessageUtil();
        this.messageParser = new MessageHandler();

        if (debug) this.debug = debug;

        this.setupEvents();
    }


    async init(metadata: HashConnectTypes.AppMetadata | HashConnectTypes.WalletMetadata, privKey?: string): Promise<HashConnectTypes.InitilizationData> {

        return new Promise(async (resolve) => {
            this.metadata = metadata;

            if (this.debug) console.log("hashconnect - Initializing")

            if (!privKey)
                this.privateKey = await this.generateEncryptionKeys();
            else
                this.privateKey = privKey;

            metadata.publicKey = this.privateKey;

            let initData: HashConnectTypes.InitilizationData = {
                privKey: this.privateKey
            }

            if (window)
                this.metadata.url = window.location.origin;

            await this.relay.init();

            if (this.debug) console.log("hashconnect - Initialized")

            resolve(initData);
        });
    }


    async connect(topic?: string, metadataToConnect?: HashConnectTypes.AppMetadata | HashConnectTypes.WalletMetadata): Promise<HashConnectTypes.ConnectionState> {
        if (!topic) {
            topic = this.messages.createRandomTopicId();
            this.publicKeys[topic] = this.privateKey;
            if (this.debug) console.log("hashconnect - Created new topic id - " + topic);
        }

        if (metadataToConnect)
            this.publicKeys[topic] = metadataToConnect.publicKey as string;

        let state: HashConnectTypes.ConnectionState = {
            topic: topic,
            expires: 0
        }

        await this.relay.subscribe(state.topic);

        return state;
    }

    /**
     * Set up event connections
     */
    private setupEvents() {
        // This will listen for a payload emission from the relay
        if (this.debug) console.log("hashconnect - Setting up events");
        this.relay.payload.on(async (payload) => {
            if (!payload) return;

            //this is redundant until protobuffs are re-implemented
            const message: RelayMessage = await this.messages.decode(payload, this);

            await this.messageParser.onPayload(message, this);
        })
    }


    /**
     * Send functions
     */
    async sendTransaction(topic: string, transaction: MessageTypes.Transaction): Promise<MessageTypes.TransactionResponse> {
        transaction.byteArray = Buffer.from(transaction.byteArray).toString("base64");

        const msg = await this.messages.prepareSimpleMessage(RelayMessageType.Transaction, transaction, topic, this);
        await this.relay.publish(topic, msg, this.publicKeys[topic]);
        this.sendEncryptedLocalTransaction(msg);

        return await new Promise<MessageTypes.TransactionResponse>(resolve => this.transactionResolver = resolve)
    }

    async requestAdditionalAccounts(topic: string, message: MessageTypes.AdditionalAccountRequest): Promise<MessageTypes.AdditionalAccountResponse> {
        const msg = await this.messages.prepareSimpleMessage(RelayMessageType.AdditionalAccountRequest, message, topic, this);

        await this.relay.publish(topic, msg, this.publicKeys[topic]);
        
        return await new Promise<MessageTypes.AdditionalAccountResponse>(resolve => this.additionalAccountResolver = resolve)

    }

    async sendAdditionalAccounts(topic: string, message: MessageTypes.AdditionalAccountResponse): Promise<string> {
        message.accountIds = message.accountIds.map(id => { return id });

        const msg = await this.messages.prepareSimpleMessage(RelayMessageType.AdditionalAccountResponse, message, topic, this);

        await this.relay.publish(topic, msg, this.publicKeys[topic]);

        return message.id!;
    }

    async sendTransactionResponse(topic: string, message: MessageTypes.TransactionResponse): Promise<string> {
        if (message.receipt) message.receipt = Buffer.from(message.receipt).toString("base64");
        if (message.signedTransaction) message.signedTransaction = Buffer.from(message.signedTransaction).toString("base64");


        const msg = await this.messages.prepareSimpleMessage(RelayMessageType.TransactionResponse, message, topic, this);

        await this.relay.publish(topic, msg, this.publicKeys[topic]);

        return message.id!;
    }

    async pair(pairingData: HashConnectTypes.PairingData, accounts: string[], network: string): Promise<HashConnectTypes.ConnectionState> {
        if (this.debug) console.log("hashconnect - Pairing to " + pairingData.metadata.name);
        let state = await this.connect(pairingData.topic);

        let msg: MessageTypes.ApprovePairing = {
            metadata: this.metadata as HashConnectTypes.WalletMetadata,
            topic: pairingData.topic,
            accountIds: accounts,
            network: network
        }

        msg.metadata.description = this.sanitizeString(msg.metadata.description);
        msg.metadata.name = this.sanitizeString(msg.metadata.name);
        msg.metadata.publicKey = pairingData.metadata.publicKey;
        msg.network = this.sanitizeString(msg.network);
        msg.metadata.url = this.sanitizeString(msg.metadata.url!);
        msg.accountIds = msg.accountIds.map(id => { return id });

        this.publicKeys[pairingData.topic] = pairingData.metadata.publicKey as string;

        const payload = await this.messages.prepareSimpleMessage(RelayMessageType.ApprovePairing, msg, msg.topic, this)

        this.relay.publish(pairingData.topic, payload, this.publicKeys[pairingData.topic])

        return state;
    }

    async reject(topic: string, reason: string, msg_id: string) {
        let reject: MessageTypes.Rejected = {
            reason: reason,
            topic: topic,
            msg_id: msg_id
        }

        reject.reason = this.sanitizeString(reject.reason!);

        // create protobuf message
        const msg = await this.messages.prepareSimpleMessage(RelayMessageType.RejectPairing, reject, topic, this)

        // Publish the rejection
        await this.relay.publish(topic, msg, this.publicKeys[topic]);
    }

    async acknowledge(topic: string, pubKey: string, msg_id: string) {
        const ack: MessageTypes.Acknowledge = {
            result: true,
            topic: topic,
            msg_id: msg_id
        }

        const ackPayload = await this.messages.prepareSimpleMessage(RelayMessageType.Acknowledge, ack, topic, this);
        await this.relay.publish(topic, ackPayload, pubKey)
    }


    async authenticate(topic: string, account_id: string, server_signing_account: string, serverSignature: Uint8Array, payload: {url: string, data: any }): Promise<MessageTypes.AuthenticationResponse> {
        let message: MessageTypes.AuthenticationRequest = {
            topic: topic,
            accountToSign: account_id,
            serverSigningAccount: server_signing_account,
            serverSignature: serverSignature,
            payload: payload
        }

        message.serverSignature = Buffer.from(message.serverSignature).toString("base64")
        console.log(message.serverSignature)
        const msg = await this.messages.prepareSimpleMessage(RelayMessageType.AuthenticationRequest, message, topic, this);
        await this.relay.publish(topic, msg, this.publicKeys[topic]);
        this.sendEncryptedLocalTransaction(msg);

        return await new Promise<MessageTypes.AuthenticationResponse>(resolve => this.authResolver = resolve)
    }

    async sendAuthenticationResponse(topic: string, message: MessageTypes.AuthenticationResponse): Promise<string> {
        if (message.userSignature) message.userSignature = Buffer.from(message.userSignature).toString("base64");
        if (message.signedPayload) message.signedPayload.serverSignature = Buffer.from(message.signedPayload.serverSignature).toString("base64");

        const msg = await this.messages.prepareSimpleMessage(RelayMessageType.AuthenticationResponse, message, topic, this);

        await this.relay.publish(topic, msg, this.publicKeys[topic]);

        return message.id!;
    }


    /**
     * Helpers
     */

    generatePairingString(state: HashConnectTypes.ConnectionState, network: string, multiAccount: boolean): string {
        if (this.debug) console.log("hashconnect - Generating pairing string");

        let data: HashConnectTypes.PairingData = {
            metadata: this.metadata,
            topic: state.topic,
            network: network,
            multiAccount: multiAccount
        }

        data.metadata.description = this.sanitizeString(data.metadata.description);
        data.metadata.name = this.sanitizeString(data.metadata.name);
        data.network = this.sanitizeString(data.network);
        data.metadata.url = this.sanitizeString(data.metadata.url!);

        let pairingString: string = Buffer.from(JSON.stringify(data)).toString("base64")

        return pairingString;
    }

    decodePairingString(pairingString: string) {
        let json_string: string = Buffer.from(pairingString, 'base64').toString();
        let data: HashConnectTypes.PairingData = JSON.parse(json_string);
        // data.metadata.publicKey = Buffer.from(data.metadata.publicKey as string, 'base64');
        
        return data;
    }

    private async generateEncryptionKeys(): Promise<string> { //https://github.com/diafygi/webcrypto-examples/#rsa-oaep---encrypt
        let key = this.messages.createRandomTopicId()
        
        if (this.debug) console.log("hashconnect - Generated new encryption key - " + key);
        
        return key;
    }

    private sanitizeString(str: string) {
        return str.replace(/[^\w. ]/gi, function (c) {
            if (c == ".") return ".";
            return '&#' + c.charCodeAt(0) + ';';
        });
    }

    /**
     * Local wallet stuff
     */

    findLocalWallets() {
        if (this.debug) console.log("hashconnect - Finding local wallets");
        window.addEventListener("message", (event) => {
            if (event.data.type && (event.data.type == "hashconnect-query-extension-response")) {
                if (this.debug) console.log("hashconnect - Local wallet metadata recieved", event.data);
                if (event.data.metadata)
                    this.foundExtensionEvent.emit(event.data.metadata);
            }
        }, false);

        setTimeout(() => {
            window.postMessage({ type: "hashconnect-query-extension" }, "*");
        }, 50);
    }

    connectToLocalWallet(pairingString: string) {
        if (this.debug) console.log("hashconnect - Connecting to local wallet")
        //todo: add extension metadata support
        window.postMessage({ type: "hashconnect-connect-extension", pairingString: pairingString }, "*")
    }

    sendEncryptedLocalTransaction(message: string) {
        if (this.debug) console.log("hashconnect - sending local transaction", message);        
        window.postMessage({ type: "hashconnect-send-local-transaction", message: message }, "*")
    }

    async decodeLocalTransaction(message: string){
        const local_message: RelayMessage = await this.messages.decode(message, this);

        return local_message;
    }



    /**
     * Provider stuff
     */
    
    getProvider(network:string, topicId: string, accountToSign: string): HashConnectProvider {
        return new HashConnectProvider(network, this, topicId, accountToSign);
    }

    getSigner(provider: HashConnectProvider): HashConnectSigner {
        return new HashConnectSigner(this, provider, provider.accountToSign, provider.topicId);
    }
}