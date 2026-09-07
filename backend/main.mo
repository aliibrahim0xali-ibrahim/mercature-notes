import Map "mo:core/Map";
import Iter "mo:core/Iter";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Char "mo:core/Char";
import Principal "mo:core/Principal";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Runtime "mo:core/Runtime";
import MemphisAuth "mo:thebes-lib/MemphisAuth";

persistent actor Notes {

  public type Note = {
    id : Nat;
    title : Text;
    body : Text;
    owner : Principal;
  };

  var nextId : Nat = 0;
  let notes = Map.empty<Nat, Note>();
  let balances = Map.empty<Principal, Nat>();

  var gate = MemphisAuth.initFromCid(921, "mercature-notes", 1);
  let AUDIENCE = "https://memphis.mercaturaforum.com";

  func hexDigit(c : Char) : Nat8 {
    let code = Char.toNat32(c);
    if (code >= 48 and code <= 57) { Nat8.fromNat(Nat32.toNat(code - 48)) }
    else if (code >= 97 and code <= 102) { Nat8.fromNat(Nat32.toNat(code - 97) + 10) }
    else if (code >= 65 and code <= 70) { Nat8.fromNat(Nat32.toNat(code - 65) + 10) }
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

  public func createNote(session : Text, title : Text, body : Text) : async Nat {
    let owner = await* authenticate(session);
    ignore ensureBalance(owner);
    let id = nextId;
    nextId += 1;
    Map.add(notes, Nat.compare, id, { id; title; body; owner });
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

  public func myBalance(session : Text) : async Nat {
    let caller = await* authenticate(session);
    ensureBalance(caller);
  };

  // Bonus: a public conservation check — total points in circulation must
  // always equal 100 × the number of accounts that have ever been granted
  // a starting balance, since points are only ever minted once and never
  // moved or destroyed (trading comes in a later task). Wrapped in a
  // 1-element vec (not a bare record) so the client's decodeVecRecord can
  // read it — it only knows how to decode `vec record`.
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
