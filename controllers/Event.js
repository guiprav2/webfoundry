import EventEmitter from 'https://cdn.jsdelivr.net/npm/eventemitter2@6.4.9/+esm';

export default class Event {
  state = {
    bus: new EventEmitter({ wildcard: true, delimiter: ':', asyncListeners: true }),
  };

  actions = {
    init: () => {
      let { bus } = this.state;
      let oemit = bus.emit;
      bus.emit = function (name, data) {
        data ??= {};
        if (typeof data === 'object') data.event = name;
        return oemit.call(this, name, data);
      };
      let oemitAsync = bus.emit;
      bus.emitAsync = function (name, data) {
        data ??= {};
        if (typeof data === 'object') data.event = name;
        return oemitAsync.call(this, name, data);
      };
    },
  };
};
