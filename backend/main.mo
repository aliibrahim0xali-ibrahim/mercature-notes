import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Char "mo:core/Char";
import Principal "mo:core/Principal";
import Iter "mo:core/Iter";
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

  public func createNote(session : Text, title : Text, body : Text) : async Nat {
    let owner = await* authenticate(session);
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
};
