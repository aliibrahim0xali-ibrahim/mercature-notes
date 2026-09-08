import Map "mo:core/Map";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Char "mo:core/Char";
import Principal "mo:core/Principal";
import Iter "mo:core/Iter";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Result "mo:core/Result";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";
import MemphisAuth "mo:thebes-lib/MemphisAuth";

// actor = your contract · persistent = the chain remembers
persistent actor Notes {

  public type Note = {
    id : Nat;
    title : Text;
    body : Text;
    owner : Principal;
    isShared : Bool;
    // The "attach an image" bonus (imagePath : ?Text) was dropped: the
    // frontend's Candid decoder (@thebes/sdk's boundary.js) has no support
    // for optional/opt fields, so any record carrying one can't be decoded
    // client-side. Media would need its own contract call, not a field here.
  };

  public type Tip = {
    from : Principal;
    to_ : Principal;
    noteId : Nat;
    amount : Nat;
    at : Int;
  };

  var nextId : Nat = 0;
  let notes = Map.empty<Nat, Note>();
  let balances = Map.empty<Principal, Nat>();
  let tips = List.empty<Tip>();

  // ⚠️ DO NOT TOUCH — same gate as Task 2, byte-for-byte. Changing the
  // origin string or the version number re-derives a different principal
  // for every user; all their notes and points would silently vanish.
  var gate = MemphisAuth.initFromCid(921, "mercature-notes", 1);
  let AUDIENCE = "https://memphis.mercaturaforum.com";

  // -- hex -> Blob ------------------------------------------------------
  // The frontend SDK's Candid encoder cannot produce a real `blob` argument
  // (only null/bool/nat/int/text/principal/opt/vec/record), but Memphis's
  // session token is already available client-side as `session_token_hex`
  // (plain hex text) — which the encoder handles natively as `text`. So the
  // wire type here is `Text`, and we decode it to the `Blob` MemphisAuth
  // actually needs, inside the contract.
  func hexDigit(c : Char) : Nat8 {
    let code = Char.toNat32(c);
    if (code >= 48 and code <= 57) { Nat8.fromNat(Nat32.toNat(code - 48)) } // '0'-'9'
    else if (code >= 97 and code <= 102) { Nat8.fromNat(Nat32.toNat(code - 97) + 10) } // 'a'-'f'
    else if (code >= 65 and code <= 70) { Nat8.fromNat(Nat32.toNat(code - 65) + 10) } // 'A'-'F'
    else { 0 };
  };

  func hexToBlob(hex : Text) : Blob {
    let cs = Iter.toArray(hex.chars());
    let n = cs.size() / 2;
    Blob.fromArray(
      Array.tabulate<Nat8>(n, func(i : Nat) : Nat8 {
        hexDigit(cs[i * 2]) * 16 + hexDigit(cs[i * 2 + 1]);
      })
    );
  };

  // authenticate() traps on any failure. Every public method below just
  // calls it and lets the trap propagate — the frontend's `update()` call
  // rejects with this exact message. (The client's Candid decoder also
  // can't decode a `variant`/Result reply, so returning `#err(...)` instead
  // of trapping would be just as undecodable as `Blob` was.)
  func authenticate(sessionHex : Text) : async* Principal {
    switch (await* MemphisAuth.verifyWithAudience(gate, hexToBlob(sessionHex), AUDIENCE)) {
      case (#err(#Memphis(#Unauthorized))) Runtime.trap("Signed in for another app — sign in here");
      case (#err(#Expired)) Runtime.trap("Session expired — sign in again");
      case (#err(_)) Runtime.trap("Not signed in");
      case (#ok(id)) id.principal;
    };
  };

  // Every member starts with 100 points, granted exactly once — the first
  // time we ever see their principal.
  func ensureBalance(p : Principal) : Nat {
    switch (Map.get(balances, Principal.compare, p)) {
      case (?bal) bal;
      case null {
        Map.add(balances, Principal.compare, p, 100);
        100;
      };
    };
  };

  // --- notes: create / edit / delete (unchanged rules from Task 2) ---

  public func createNote(session : Text, title : Text, body : Text) : async Nat {
    let owner = await* authenticate(session);
    ignore ensureBalance(owner);
    let id = nextId;
    nextId += 1;
    Map.add(notes, Nat.compare, id, { id; title; body; owner; isShared = false });
    id;
  };

  public func editNote(session : Text, id : Nat, title : Text, body : Text) : async Bool {
    let caller = await* authenticate(session);
    switch (Map.get(notes, Nat.compare, id)) {
      case (?note) {
        if (note.owner != caller) Runtime.trap("Not your note");
        Map.add(notes, Nat.compare, id, { note with title; body });
        true;
      };
      case null false;
    };
  };

  public func deleteNote(session : Text, id : Nat) : async Bool {
    let caller = await* authenticate(session);
    switch (Map.get(notes, Nat.compare, id)) {
      case (?note) {
        if (note.owner != caller) Runtime.trap("Not your note");
        ignore Map.delete(notes, Nat.compare, id);
        true;
      };
      case null false;
    };
  };

  public func listMyNotes(session : Text) : async [Note] {
    let caller = await* authenticate(session);
    Iter.toArray(Iter.filter(Map.values(notes), func(n : Note) : Bool { n.owner == caller }));
  };

  public func whoAmI(session : Text) : async Principal {
    await* authenticate(session);
  };

  // --- Task 3: share & tip ---

  public func shareNote(session : Text, id : Nat) : async Bool {
    let caller = await* authenticate(session);
    switch (Map.get(notes, Nat.compare, id)) {
      case (?note) {
        if (note.owner != caller) Runtime.trap("Not your note");
        Map.add(notes, Nat.compare, id, { note with isShared = true });
        true;
      };
      case null false;
    };
  };

  public func unshareNote(session : Text, id : Nat) : async Bool {
    let caller = await* authenticate(session);
    switch (Map.get(notes, Nat.compare, id)) {
      case (?note) {
        if (note.owner != caller) Runtime.trap("Not your note");
        Map.add(notes, Nat.compare, id, { note with isShared = false });
        true;
      };
      case null false;
    };
  };

  // public — anyone can look at the feed without signing in
  public query func feed() : async [Note] {
    Iter.toArray(Iter.filter(Map.values(notes), func(n : Note) : Bool { n.isShared }));
  };

  public func myBalance(session : Text) : async Nat {
    let caller = await* authenticate(session);
    ensureBalance(caller);
  };

  public func myTipHistory(session : Text) : async [Tip] {
    let caller = await* authenticate(session);
    Iter.toArray(Iter.filter(List.values(tips), func(t : Tip) : Bool { t.from == caller or t.to_ == caller }));
  };

  public func tip(session : Text, noteId : Nat, amount : Nat) : async Nat {
    let caller = await* authenticate(session);
    switch (Map.get(notes, Nat.compare, noteId)) {
      case null Runtime.trap("Note not found");
      case (?note) {
        if (not note.isShared) Runtime.trap("This note isn't shared");
        if (note.owner == caller) Runtime.trap("Rule 2: you can't tip yourself"); // Rule 2
        let myBalance_ = ensureBalance(caller);
        if (amount > myBalance_) Runtime.trap("Rule 1: you don't have that many points"); // Rule 1
        let theirBalance = ensureBalance(note.owner);
        Map.add(balances, Principal.compare, caller, myBalance_ - amount);
        Map.add(balances, Principal.compare, note.owner, theirBalance + amount);
        List.add(tips, { from = caller; to_ = note.owner; noteId; amount; at = Time.now() });
        myBalance_ - amount;
      };
    };
  };

  // Bonus: a public conservation check — total points in circulation must
  // always equal 100 × the number of accounts that have ever been granted
  // a starting balance, since tips only move points, never mint or burn
  // them. The frontend footer renders this as a small trust indicator.
  // Wrapped in a 1-element vec (not a bare record) so the client's
  // decodeVecRecord can read it — it only knows how to decode `vec record`.
  public query func ledgerSeal() : async [{ accounts : Nat; totalPoints : Nat; balanced : Bool }] {
    var total : Nat = 0;
    var count : Nat = 0;
    for (bal in Map.values(balances)) {
      total += bal;
      count += 1;
    };
    [{ accounts = count; totalPoints = total; balanced = total == count * 100 }];
  };
};
