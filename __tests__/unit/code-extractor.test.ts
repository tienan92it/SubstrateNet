import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { syncProject } from '../../src/code/sync';
import { openCodeDb } from '../../src/db/connection';

describe('L0 code extractor', () => {
  it('indexes a TypeScript file with classes, methods, and functions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-ext-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'src/sample.ts'),
        `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
  sub(a: number, b: number): number {
    return this.add(a, -b);
  }
}

export function makeCalc(): Calculator {
  return new Calculator();
}

const helper = () => makeCalc();
`,
      );

      const stats = await syncProject(root);
      expect(stats.filesIndexed).toBe(1);
      expect(stats.errors).toBe(0);

      const db = openCodeDb(root);
      const nodes = db.prepare(`SELECT name, kind FROM nodes ORDER BY name`).all() as Array<{
        name: string; kind: string;
      }>;
      const names = nodes.map((n) => n.name);
      expect(names).toContain('Calculator');
      expect(names).toContain('add');
      expect(names).toContain('sub');
      expect(names).toContain('makeCalc');
      expect(names).toContain('helper');

      const containment = db
        .prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind='contains'`).get() as { n: number };
      expect(containment.n).toBeGreaterThan(0);

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes Python classes and functions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-py-'));
    try {
      writeFileSync(
        join(root, 'mod.py'),
        `class Greeter:
    def hello(self, name: str) -> str:
        return f"hi {name}"

def make_greeter() -> Greeter:
    return Greeter()
`,
      );
      const stats = await syncProject(root);
      expect(stats.filesIndexed).toBe(1);
      const db = openCodeDb(root);
      const names = (db.prepare(`SELECT name FROM nodes`).all() as Array<{ name: string }>)
        .map((n) => n.name);
      expect(names).toContain('Greeter');
      expect(names).toContain('hello');
      expect(names).toContain('make_greeter');
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes Dart / Flutter files: classes, mixins, methods, fields, imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-dart-'));
    try {
      mkdirSync(join(root, 'lib'));
      writeFileSync(
        join(root, 'lib/counter.dart'),
        `import 'package:flutter/material.dart';
import 'dart:async';

abstract class Animal {
  String get name;
}

mixin Walks {
  void walk() {}
}

class Counter extends Animal with Walks {
  final String name;
  int value = 0;

  Counter(this.name);

  void increment() { value++; }
  int doubled() => value * 2;
  Future<int> count() async => 42;
}

void main() {
  print('hi');
}
`,
      );
      const stats = await syncProject(root);
      expect(stats.filesIndexed).toBe(1);
      expect(stats.errors).toBe(0);
      const db = openCodeDb(root);
      const nodes = db.prepare(`SELECT name, kind FROM nodes`).all() as Array<{ name: string; kind: string }>;
      const byKind = (k: string) => nodes.filter((n) => n.kind === k).map((n) => n.name);

      expect(byKind('class')).toEqual(expect.arrayContaining(['Animal', 'Walks', 'Counter']));
      expect(byKind('method')).toEqual(expect.arrayContaining(['walk', 'increment', 'doubled', 'count']));
      expect(byKind('function')).toContain('main');
      expect(byKind('field')).toEqual(expect.arrayContaining(['name', 'value']));
      expect(byKind('import').some((n) => n.includes('package:flutter/material.dart'))).toBe(true);
      expect(byKind('import').some((n) => n === 'dart:async')).toBe(true);

      const containment = db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind='contains'`).get() as { n: number };
      expect(containment.n).toBeGreaterThan(5);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes Dart enums, extensions, and typedefs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-dart2-'));
    try {
      writeFileSync(
        join(root, 'lib.dart'),
        `enum Status { pending, succeeded, failed }

enum Priority {
  low('L'),
  high('H');
  final String code;
  const Priority(this.code);
  String describe() => 'priority \$code';
}

extension StringX on String {
  bool get isBlank => trim().isEmpty;
  String shout() => toUpperCase();
}

extension on int {
  int squared() => this * this;
}

typedef IntList = List<int>;
typedef Predicate<T> = bool Function(T value);
`,
      );
      const stats = await syncProject(root);
      expect(stats.errors).toBe(0);

      const db = openCodeDb(root);
      const nodes = db.prepare(`SELECT name, kind FROM nodes`).all() as Array<{ name: string; kind: string }>;
      const byKind = (k: string) => nodes.filter((n) => n.kind === k).map((n) => n.name);

      expect(byKind('enum')).toEqual(expect.arrayContaining(['Status', 'Priority']));
      expect(byKind('enum_member')).toEqual(
        expect.arrayContaining(['pending', 'succeeded', 'failed', 'low', 'high']),
      );
      expect(byKind('type_alias')).toEqual(expect.arrayContaining(['IntList', 'Predicate']));

      // Extensions: named StringX + synthetic name for the anonymous one
      const classNames = byKind('class');
      expect(classNames).toContain('StringX');
      expect(classNames.some((n) => n.startsWith('__ext_on_'))).toBe(true);

      // Enum members get methods/fields too: Priority has describe() and code field.
      expect(byKind('method')).toContain('describe');
      expect(byKind('field')).toContain('code');

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes Go: package, imports, funcs, methods, structs, interfaces, enums, type aliases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-go-'));
    try {
      writeFileSync(
        join(root, 'main.go'),
        `package server

import (
\t"context"
\t"fmt"
\tpb "example.com/proto"
)
import "errors"

const MaxRetries = 3
var defaultTimeout = 30

type Status int

const (
\tStatusPending Status = iota
\tStatusOK
)

type User struct {
\tID   string
\tName string
}

type Greeter interface {
\tGreet(name string) string
}

func (u *User) FullName() string { return u.Name }
func NewUser(name string) *User { return &User{Name: name} }
func main() { fmt.Println(NewUser("x")) }

type Handler = func(ctx context.Context) error
`,
      );
      const stats = await syncProject(root);
      expect(stats.errors).toBe(0);

      const db = openCodeDb(root);
      const nodes = db.prepare(`SELECT name, kind FROM nodes`).all() as Array<{ name: string; kind: string }>;
      const byKind = (k: string) => nodes.filter((n) => n.kind === k).map((n) => n.name);

      expect(byKind('struct')).toContain('User');
      expect(byKind('interface')).toContain('Greeter');
      expect(byKind('type_alias')).toEqual(expect.arrayContaining(['Status', 'Handler']));
      expect(byKind('function')).toEqual(expect.arrayContaining(['NewUser', 'main']));
      expect(byKind('method')).toEqual(expect.arrayContaining(['FullName', 'Greet']));
      expect(byKind('field')).toEqual(expect.arrayContaining(['ID', 'Name']));
      expect(byKind('constant')).toEqual(expect.arrayContaining(['MaxRetries', 'StatusPending', 'StatusOK']));
      expect(byKind('variable')).toContain('defaultTimeout');
      expect(byKind('import')).toEqual(expect.arrayContaining(['context', 'fmt', 'example.com/proto', 'errors']));

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes Rust: structs, enums, traits, impls, fns, methods, consts, uses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-rs-'));
    try {
      writeFileSync(
        join(root, 'lib.rs'),
        `use std::collections::HashMap;
use crate::api::{Client, Request};

const MAX: u32 = 10;
static GREETING: &str = "hi";

pub mod auth {
    pub fn login() {}
}

pub struct User { pub id: u64, name: String }

pub enum Status { Pending, Ok(u32), Failed }

pub trait Greet { fn greet(&self) -> String; }

impl User {
    pub fn new(name: String) -> Self { Self { id: 0, name } }
    pub fn name(&self) -> &str { &self.name }
}

impl Greet for User {
    fn greet(&self) -> String { format!("hi {}", self.name) }
}

pub type Result<T> = std::result::Result<T, anyhow::Error>;

pub fn make_user(name: String) -> User { User::new(name) }
fn main() { let u = make_user("x".into()); println!("{}", u.greet()); }
`,
      );
      const stats = await syncProject(root);
      expect(stats.errors).toBe(0);
      const db = openCodeDb(root);
      const nodes = db.prepare(`SELECT name, kind FROM nodes`).all() as Array<{ name: string; kind: string }>;
      const byKind = (k: string) => nodes.filter((n) => n.kind === k).map((n) => n.name);

      expect(byKind('struct')).toContain('User');
      expect(byKind('enum')).toContain('Status');
      expect(byKind('enum_member')).toEqual(expect.arrayContaining(['Pending', 'Ok', 'Failed']));
      expect(byKind('interface')).toContain('Greet'); // trait
      expect(byKind('module')).toContain('auth');
      expect(byKind('class')).toEqual(expect.arrayContaining(['impl User', 'impl Greet for User']));
      expect(byKind('function')).toEqual(expect.arrayContaining(['make_user', 'main', 'login']));
      expect(byKind('method')).toEqual(expect.arrayContaining(['new', 'name', 'greet']));
      expect(byKind('constant')).toEqual(expect.arrayContaining(['MAX', 'GREETING']));
      expect(byKind('type_alias')).toContain('Result');
      expect(byKind('field')).toEqual(expect.arrayContaining(['id', 'name']));
      expect(byKind('import').some((n) => n.includes('HashMap'))).toBe(true);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes Java: package, imports, classes, interfaces, enums, fields, methods, records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-java-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src/Demo.java'),
        `package com.example.demo;

import java.util.List;
import java.util.Map;
import static java.lang.Math.PI;

public interface Greeter { String greet(String name); }

public enum Status { PENDING, OK, FAILED }

public abstract class Animal {
    protected String name;
    public Animal(String name) { this.name = name; }
    public abstract void speak();
    public String getName() { return name; }
}

public class Dog extends Animal implements Greeter {
    private final int age;
    public static final int MAX_AGE = 20;

    public Dog(String name, int age) { super(name); this.age = age; }

    @Override public void speak() { System.out.println("woof"); }
    @Override public String greet(String to) { return "hi " + to; }
}

record Point(int x, int y) {}
`,
      );
      const stats = await syncProject(root);
      expect(stats.errors).toBe(0);
      const db = openCodeDb(root);
      const nodes = db.prepare(`SELECT name, kind FROM nodes`).all() as Array<{ name: string; kind: string }>;
      const byKind = (k: string) => nodes.filter((n) => n.kind === k).map((n) => n.name);

      expect(byKind('interface')).toContain('Greeter');
      expect(byKind('enum')).toContain('Status');
      expect(byKind('enum_member')).toEqual(expect.arrayContaining(['PENDING', 'OK', 'FAILED']));
      expect(byKind('class')).toEqual(expect.arrayContaining(['Animal', 'Dog', 'Point']));
      expect(byKind('method')).toEqual(expect.arrayContaining(['speak', 'getName', 'greet', 'Animal', 'Dog']));
      expect(byKind('field')).toEqual(expect.arrayContaining(['name', 'age', 'MAX_AGE']));
      expect(byKind('import')).toEqual(expect.arrayContaining(['java.util.List', 'java.util.Map']));
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes SQL DDL: tables, columns, FK refs, views, indexes, functions, sequences', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-sql-'));
    try {
      writeFileSync(
        join(root, 'schema.sql'),
        `-- accounts schema dump
CREATE SCHEMA IF NOT EXISTS app;

CREATE SEQUENCE IF NOT EXISTS accounts_account_no_seq;

CREATE TABLE "public"."accounts" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "display_name" varchar,
    "binance_user_id" varchar,
    "is_demo" bool,
    "trading_tab" uuid,
    "tier" uuid,
    "account_no" int4 NOT NULL DEFAULT nextval('accounts_account_no_seq'::regclass),
    CONSTRAINT "accounts_trading_tab_fkey" FOREIGN KEY ("trading_tab") REFERENCES "public"."trading_tabs"("id"),
    CONSTRAINT "accounts_tier_fkey" FOREIGN KEY ("tier") REFERENCES "public"."tier"("id"),
    PRIMARY KEY ("id")
);

CREATE TABLE "public"."users_accounts" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" uuid REFERENCES users(id),
    "account_id" uuid REFERENCES accounts(id),
    "scopes" _varchar DEFAULT ARRAY[]::character varying[],
    PRIMARY KEY ("id")
);

CREATE TABLE "public"."users" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "email" varchar,
    "telegram" varchar,
    PRIMARY KEY ("id")
);

CREATE INDEX idx_users_email ON users (email);
CREATE UNIQUE INDEX accounts_no_unique ON accounts (account_no);

CREATE OR REPLACE VIEW active_accounts AS
  SELECT a.* FROM accounts a WHERE a.is_demo = false;

CREATE OR REPLACE FUNCTION public.get_account(account_id uuid) RETURNS uuid AS $$
  SELECT id FROM accounts WHERE id = account_id;
$$ LANGUAGE sql;

ALTER TABLE users ADD COLUMN created_at timestamptz DEFAULT now();
`,
      );
      const stats = await syncProject(root);
      expect(stats.errors).toBe(0);
      expect(stats.filesIndexed).toBe(1);

      const db = openCodeDb(root);
      const nodes = db.prepare(`SELECT name, kind FROM nodes`).all() as Array<{ name: string; kind: string }>;
      const byKind = (k: string) => nodes.filter((n) => n.kind === k).map((n) => n.name);

      // Tables + view (view modeled as table)
      expect(byKind('table')).toEqual(expect.arrayContaining(['accounts', 'users', 'users_accounts', 'active_accounts']));
      // Columns
      expect(byKind('field')).toEqual(expect.arrayContaining([
        'id', 'display_name', 'binance_user_id', 'is_demo', 'trading_tab', 'tier', 'account_no',
        'user_id', 'account_id', 'email', 'telegram',
      ]));
      // ALTER TABLE ADD COLUMN
      expect(byKind('field')).toContain('created_at');
      // Indexes
      expect(byKind('index')).toEqual(expect.arrayContaining(['idx_users_email', 'accounts_no_unique']));
      // Function
      expect(byKind('function')).toContain('get_account');
      // Sequence (variable)
      expect(byKind('variable')).toContain('accounts_account_no_seq');
      // Schema
      expect(byKind('namespace')).toContain('app');

      // FK references — should produce 'references' edges from accounts -> trading_tabs / tier
      // and from user_accounts.user_id -> users, .account_id -> accounts
      const refEdges = db.prepare(`SELECT metadata FROM edges WHERE kind='references'`).all() as Array<{ metadata: string }>;
      const targets = refEdges.map((r) => JSON.parse(r.metadata).target_table);
      expect(targets).toEqual(expect.arrayContaining(['trading_tabs', 'tier', 'users', 'accounts']));

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes C#: usings, namespace, classes, structs, interfaces, enums, records, properties, methods', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-cs-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src/Demo.cs'),
        `using System;
using System.Collections.Generic;
using Foo = MyCompany.Foo;

namespace MyApp.Services {
  public enum Status { Pending, Ok, Failed }

  public delegate string Greeter(string name);

  public interface IRepo<T> {
      T Find(int id);
      void Save(T item);
  }

  public abstract record Animal(string Name);
  public record class Cat(string Name, int Lives);

  public struct Point {
      public int X;
      public int Y { get; set; }
  }

  public class UserService : IRepo<User> {
      private readonly List<User> _users = new();
      public const int MaxUsers = 100;
      public static readonly string Greeting = "hi";

      public UserService() {}
      public User Find(int id) => _users.Find(u => u.Id == id);
      public void Save(User u) { _users.Add(u); }
      public string Name { get; set; }
      public event EventHandler? Created;
  }
}
`,
      );
      const stats = await syncProject(root);
      expect(stats.errors).toBe(0);
      const db = openCodeDb(root);
      const nodes = db.prepare(`SELECT name, kind FROM nodes`).all() as Array<{ name: string; kind: string }>;
      const byKind = (k: string) => nodes.filter((n) => n.kind === k).map((n) => n.name);

      expect(byKind('module')).toContain('MyApp.Services');
      expect(byKind('enum')).toContain('Status');
      expect(byKind('enum_member')).toEqual(expect.arrayContaining(['Pending', 'Ok', 'Failed']));
      expect(byKind('interface')).toContain('IRepo');
      expect(byKind('class')).toEqual(expect.arrayContaining(['Animal', 'Cat', 'UserService']));
      expect(byKind('struct')).toContain('Point');
      expect(byKind('type_alias')).toContain('Greeter'); // delegate
      expect(byKind('property')).toEqual(expect.arrayContaining(['Y', 'Name']));
      expect(byKind('method')).toEqual(expect.arrayContaining(['Find', 'Save', 'UserService']));
      expect(byKind('field')).toEqual(expect.arrayContaining(['_users', 'MaxUsers', 'Greeting', 'X', 'Created']));
      expect(byKind('import')).toEqual(expect.arrayContaining([
        'System', 'System.Collections.Generic', 'MyCompany.Foo',
      ]));
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('indexes Elixir: modules, functions, imports, and remote calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-ex-'));
    try {
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(
        join(root, 'lib/user.ex'),
        `defmodule MyApp.User do
  alias MyApp.Repo
  import Ecto.Query
  use GenServer

  def hello(name) do
    greet(name)
    Repo.all(User)
  end

  defp greet(x), do: x
end

Remote.ping()
`,
      );
      const stats = await syncProject(root);
      expect(stats.filesIndexed).toBe(1);
      expect(stats.errors).toBe(0);

      const db = openCodeDb(root);
      const nodes = db.prepare(`SELECT name, kind FROM nodes`).all() as Array<{ name: string; kind: string }>;
      const byKind = (k: string) => nodes.filter((n) => n.kind === k).map((n) => n.name);

      expect(byKind('module')).toContain('MyApp.User');
      expect(byKind('method')).toEqual(expect.arrayContaining(['hello', 'greet']));
      expect(byKind('import')).toEqual(expect.arrayContaining(['MyApp.Repo', 'Ecto.Query', 'GenServer']));

      const refs = db.prepare(`SELECT reference_name FROM unresolved_refs`).all() as Array<{ reference_name: string }>;
      expect(refs.map((r) => r.reference_name)).toEqual(expect.arrayContaining(['all', 'ping']));

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is incremental: second sync with no changes skips files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subnet-inc-'));
    try {
      writeFileSync(join(root, 'a.ts'), `export function f(): number { return 1; }`);
      const s1 = await syncProject(root);
      expect(s1.filesIndexed).toBe(1);
      expect(s1.filesSkipped).toBe(0);
      const s2 = await syncProject(root);
      expect(s2.filesIndexed).toBe(0);
      expect(s2.filesSkipped).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
