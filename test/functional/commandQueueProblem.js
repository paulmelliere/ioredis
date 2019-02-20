'use strict';

function reconnectAndWait (mockServer) {
  let onReconnect = null;
  let waitForReconnect = new Promise(resolve => { onReconnect = resolve; });
  mockServer.disconnect(() => {
    // Resolve the promise after reconnect
    mockServer.once('connect', () => onReconnect());
    mockServer.connect();
  });
  return waitForReconnect;
}

function continueWhenClientReady (redis) {
  return new Promise(resolve => {
    redis.once('ready', resolve);
  });
}

describe('commandQueue problem', function() {
  let continueAfterReconnect;
  let mockServer;
  
  beforeEach(function() {
    let multiPings = null;
    let onReconnect;
    // create a promise that will not resolve until the mockServer receives a ping command with arg 'reconnect', disconnects, and reconnects 
    continueAfterReconnect = new Promise(resolve => { onReconnect = resolve });
    
    const handler = ([command, arg]) => {
      if (command === 'multi') {
        multiPings = [];
        return 'OK';
      }
      
      if (command === 'exec') {
        const res = multiPings;
        multiPings = null;
        return res;
      }
  
      if (command === 'ping') {
        if (arg === 'reconnect') {
          multiPings = null;
          continueAfterReconnect = reconnectAndWait(mockServer).then(onReconnect);
          return;
        }
  
        // in a transaction
        if (multiPings) {
          multiPings.push(arg);
          return 'QUEUED';
        }
  
        // not in a transaction, reply immediately with the arg
        return arg;
      }
    };
    mockServer = new MockServer(30006, handler);
  });

  afterEach(function() {
    continueAfterReconnect = null;
    mockServer = null;
  })

  it('baseline - should return ping results', async function() {
    const redis = new Redis({port: 30006});
    await continueWhenClientReady(redis);

    const pipelinePromise = redis.multi().ping('a').ping('b').exec();
    
    const pingC = redis.ping('c');
    const pingD = redis.ping('d');
    const pingE = redis.ping('e');
    
    expect(await pipelinePromise).to.eql([[null, 'a'], [null, 'b']]);
    expect(await pingC).to.eql('c');
    expect(await pingD).to.eql('d');
    expect(await pingE).to.eql('e');
  });

  
  it('should not corrupt command queue after reconnect (autoResendUnfulfilledCommands: false)', async function() {
    const redis = new Redis({port: 30006, autoResendUnfulfilledCommands: false});
    await continueWhenClientReady(redis);
    
    const pipelinePromise = redis.multi().ping('a').ping('reconnect').exec();
    // wait for the server to re-open the socket
    await continueAfterReconnect;
    // wait for the client to reconnect to the server
    await continueWhenClientReady(redis);
    
    const pingC = redis.ping('c');
    const pingD = redis.ping('d');
    const pingE = redis.ping('e');
    
    expect(await pingC).to.eql('c');
    expect(await pingD).to.eql('d');
    expect(await pingE).to.eql('e');
  });
  
  it('should not corrupt command queue after reconnect (autoResendUnfulfilledCommands: true)', async function() {
    const redis = new Redis({port: 30006});
    await continueWhenClientReady(redis);

    const pipelinePromise = redis.multi().ping('a').ping('reconnect').exec();
    // wait for the server to re-open the socket
    await continueAfterReconnect;
    // wait for the client to reconnect to the server
    await continueWhenClientReady(redis);

    const pingC = redis.ping('c');
    const pingD = redis.ping('d');
    const pingE = redis.ping('e');
    
    // the promise for pingC will return 'e', because the replies from pingC and pingD were delivered to the pipeline.
    expect(await pingC).to.eql('c');
    // if the pingC assertion is removed, these 2 promises will never resolve because the replies were delivered to different promises and the commandQueue is empty
    expect(await pingD).to.eql('d');
    expect(await pingE).to.eql('e');
  });

  it('should not timeout waiting for command after reconnect', async function() {
    const redis = new Redis({port: 30006, enableOfflineQueue: false});
    await continueWhenClientReady(redis);

    const pipelinePromise = redis.multi().ping('a').ping('reconnect').exec();
    // wait for the server to re-open the socket
    await continueAfterReconnect;
    // wait for the client to reconnect to the server
    await continueWhenClientReady(redis);
    
    // this will timeout even though mockServer responds to the ping, because the reply is delivered to the pipeline promise rather than the pingC promise
    await redis.ping('c');
  });
});