interface ResultInterface {
  SUCCEEDED: number;
  NOTRANSITION: number;
  CANCELLED: number;
  PENDING: number;
}

interface ErrorInterface {
  INVALID_TRANSITION: number;
  PENDING_TRANSITION: number;
  INVALID_CALLBACK: number;
}


export default class StateMachine {

  //---------------------------------------------------------------------------

  private static VERSION: string = "2.4.0";

  //---------------------------------------------------------------------------

  private static readonly Result: ResultInterface = {
    SUCCEEDED: 1, // the event transitioned successfully from one state to another
    NOTRANSITION: 2, // the event was successfull but no state transition was necessary
    CANCELLED: 3, // the event was cancelled by the caller in a beforeEvent callback
    PENDING: 4  // the event is asynchronous and the caller is in control of when the transition occurs
  };

  private static readonly Error: ErrorInterface = {
    INVALID_TRANSITION: 100, // caller tried to fire an event that was innapropriate in the current state
    PENDING_TRANSITION: 200, // caller tried to fire an event while an async transition was still pending
    INVALID_CALLBACK: 300 // caller provided callback function threw an exception
  };

  private static readonly WILDCARD: string = '*';
  private static readonly ASYNC: string = 'async';

  //---------------------------------------------------------------------------

  public static create(cfg:any, target: any){

    let initial = (typeof cfg.initial == 'string') ? { state: cfg.initial } : cfg.initial; // allow for a simple string, or an object with { state: 'foo', event: 'setup', defer: true|false }
    let terminal = cfg.terminal || cfg['final'];
    let fsm = target;
    let events = cfg.events || [];
    let callbacks = cfg.callbacks || {};
    let map = {}; // track state transitions allowed for an event { event: { from: [ to ] } }
    let transitions = {}; // track events allowed from a state            { state: [ event ] }

    let add = function (e) {
      let from = Array.isArray(e.from) ? e.from : (e.from ? [e.from] : [StateMachine.WILDCARD]); // allow 'wildcard' transition if 'from' is not specified
      map[e.name] = map[e.name] || {};
      for (let n = 0; n < from.length; n++) {
        transitions[from[n]] = transitions[from[n]] || [];
        transitions[from[n]].push(e.name);

        map[e.name][from[n]] = e.to || from[n]; // allow no-op transition if 'to' is not specified
      }
      if (e.to)
        transitions[e.to] = transitions[e.to] || [];
    };

    if (initial) {
        initial.event = initial.event || 'startup';
      add({ name: initial.event, from: 'none', to: initial.state });
    }

    for (let n = 0; n < events.length; n++)
      add(events[n]);

    for (let name in map) {
      if (map.hasOwnProperty(name))
        fsm[name] = StateMachine.buildEvent(name, map[name]);
    }

    for (let name in callbacks) {
      if (callbacks.hasOwnProperty(name))
        fsm[name] = callbacks[name]
    }

    fsm.current = 'none';
    fsm.is = function (state) { return Array.isArray(state) ? (state.indexOf(this.current) >= 0) : (this.current === state); };
    fsm.can = function (event) { return !this.transition && (map[event] !== undefined) && (map[event].hasOwnProperty(this.current) || map[event].hasOwnProperty(StateMachine.WILDCARD)); }
    fsm.cannot = function (event) { return !this.can(event); };
    fsm.transitions = function () { return (transitions[this.current] || []).concat(transitions[StateMachine.WILDCARD] || []); };
    fsm.isFinished = function () { return this.is(terminal); };
    fsm.error = cfg.error || function (name, from, to, args, error, msg, e) { throw e || msg; }; // default behavior when something unexpected happens is to throw an exception, but caller can override this behavior if desired (see github issue #3 and #17)
    fsm.states = function () { return Object.keys(transitions).sort() };

    if (initial && !initial.defer)
      fsm[initial.event]();

    return fsm;

  };

  //===========================================================================

  private static doCallback(fsm, func, name, from, to, args) {
    if (func) {
      try {
        if (Array.isArray(func)) {
          for (let i = 0, l = func.length; i < l; i++) {
            func[i].apply(fsm, [name, from,to].concat(args));
            //func[i](name, from, to, args);
          }
          return true;
        } else {
          func.apply(fsm, [name, from, to].concat(args));
          return true;
        }
      }
      catch (e) {
        fsm.error(name, from, to, args, StateMachine.Error.INVALID_CALLBACK, "an exception occurred in a caller-provided callback function", e);
        return true;
      }
    }
  };

  private static beforeAnyEvent(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onbeforeevent'], name, from, to, args); };
  private static afterAnyEvent(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onafterevent'] || fsm['onevent'], name, from, to, args); };
  private static leaveAnyState(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onleavestate'], name, from, to, args); };
  private static enterAnyState(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onenterstate'] || fsm['onstate'], name, from, to, args); };
  private static changeState(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onchangestate'], name, from, to, args); };

  private static beforeThisEvent(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onbefore' + name], name, from, to, args); };
  private static afterThisEvent(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onafter' + name] || fsm['on' + name], name, from, to, args); };
  private static leaveThisState(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onleave' + from], name, from, to, args); };
  private static enterThisState(fsm, name, from, to, args) { return StateMachine.doCallback(fsm, fsm['onenter' + to] || fsm['on' + to], name, from, to, args); };

  private static beforeEvent(fsm, name, from, to, args) {
    if ((false === StateMachine.beforeThisEvent(fsm, name, from, to, args)) ||
      (false === StateMachine.beforeAnyEvent(fsm, name, from, to, args)))
      return false;
  };

  private static afterEvent(fsm, name, from, to, args) {
    StateMachine.afterThisEvent(fsm, name, from, to, args);
    StateMachine.afterAnyEvent(fsm, name, from, to, args);
  };

  private static leaveState(fsm, name, from, to, args) {
    let specific = StateMachine.leaveThisState(fsm, name, from, to, args),
      general = StateMachine.leaveAnyState(fsm, name, from, to, args);
    if ((false === specific) || (false === general))
      return false;
    else if ((typeof StateMachine.ASYNC === typeof specific) || (typeof StateMachine.ASYNC === typeof general))
      return StateMachine.ASYNC;
  };

  private static enterState(fsm, name, from, to, args) {
    StateMachine.enterThisState(fsm, name, from, to, args);
    StateMachine.enterAnyState(fsm, name, from, to, args);
  };

  //===========================================================================

  private static buildEvent(name, map) {
    return function () {

      let from = this.current;
      let to = map[from] || (map[StateMachine.WILDCARD] != StateMachine.WILDCARD ? map[StateMachine.WILDCARD] : from) || from;
      let args = Array.prototype.slice.call(arguments); // turn arguments into pure array

      if (this.transition)
        return this.error(name, from, to, args, StateMachine.Error.PENDING_TRANSITION, "event " + name + " inappropriate because previous transition did not complete");

      if (this.cannot(name))
        return this.error(name, from, to, args, StateMachine.Error.INVALID_TRANSITION, "event " + name + " inappropriate in current state " + this.current);

      if (false === StateMachine.beforeEvent(this, name, from, to, args))
        return StateMachine.Result.CANCELLED;

      if (from === to) {
        StateMachine.afterEvent(this, name, from, to, args);
        return StateMachine.Result.NOTRANSITION;
      }

      // prepare a transition method for use EITHER lower down, or by caller if they want an async transition (indicated by an ASYNC return value from leaveState)
      let fsm = this;
      this.transition = function () {
        fsm.transition = null; // this method should only ever be called once
        fsm.current = to;
        StateMachine.enterState(fsm, name, from, to, args);
        StateMachine.changeState(fsm, name, from, to, args);
        StateMachine.afterEvent(fsm, name, from, to, args);
        return StateMachine.Result.SUCCEEDED;
      };
      this.transition.cancel = function () { // provide a way for caller to cancel async transition if desired (issue #22)
        fsm.transition = null;
        StateMachine.afterEvent(fsm, name, from, to, args);
      }

      let leave = StateMachine.leaveState(this, name, from, to, args);
      if (false === leave) {
        this.transition = null;
        return StateMachine.Result.CANCELLED;
      }
      else if (StateMachine.ASYNC === leave) {
        return StateMachine.Result.PENDING;
      }
      else {
        if (this.transition) // need to check in case user manually called transition() but forgot to return StateMachine.ASYNC
          return this.transition();
      }

    };
  }

};