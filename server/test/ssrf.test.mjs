// SSRF guards: address classification, DNS guard, manual redirects re-checked per hop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicIp, HostGuard, guardedFetch, parseV6 } from "../lib/net.mjs";

test("isPublicIp: private, loopback, link-local, CGNAT, multicast, mapped and NAT64 forms are not public", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "104.16.0.1", "2606:4700::1111", "2a00:1450:4001::1"]) assert.equal(isPublicIp(ip), true, ip);
  for (const ip of ["127.0.0.1", "127.9.9.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1", "[::1]", "fe80::1%en0", "2001:db8::1", "999.1.1.1", "", null]) assert.equal(isPublicIp(ip), false, String(ip));
  assert.equal(isPublicIp("::ffff:8.8.8.8"), true);
  // IPv4-compatible (::/96), 6to4 and NAT64 forms carry an IPv4 address: judged by it, or refused outright.
  for (const ip of ["::7f00:1", "::127.0.0.1", "::8.8.8.8", "2002:7f00:1::", "2002:c0a8:101::1", "64:ff9b:1::8.8.8.8", "64:ff9b:1::", "2001::1", "2001:2::1", "2001:10::1", "fec0::1", "100::1", "::ffff:0a00:1"]) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ["2002:808:808::", "64:ff9b::8.8.8.8", "64:ff9b::808:808", "2600::1"]) assert.equal(isPublicIp(ip), true, ip);
  assert.equal(parseV6("::ffff:1.2.3.4").toString("hex"), "00000000000000000000ffff01020304");
  assert.equal(parseV6("1:2:3:4:5:6:7:8:9"), null); assert.equal(parseV6("1::2::3"), null); assert.equal(parseV6("::1.2.3"), null);
});

test("HostGuard: resolves once per host, refuses any non-public answer, literal IPs need no lookup", async () => {
  const lookups = [];
  const guard = new HostGuard({ resolve: async (h) => { lookups.push(h); return h === "evil.example" ? [{ address: "93.184.216.34" }, { address: "10.0.0.5" }] : h === "dual.example" ? [{ address: "2606:4700::1111" }, { address: "93.184.216.34" }] : h === "nx.example" ? (() => { const e = new Error("ENOTFOUND"); e.code = "ENOTFOUND"; throw e; })() : [{ address: "93.184.216.34" }]; } });
  assert.deepEqual(await guard.assertPublic("ipfs.io"), { address: "93.184.216.34", family: 4 }, "the vetted address is returned for pinning");
  assert.deepEqual(await guard.assertPublic("ipfs.io"), { address: "93.184.216.34", family: 4 });
  assert.deepEqual(lookups, ["ipfs.io"], "cached");
  assert.deepEqual(await guard.assertPublic("dual.example"), { address: "93.184.216.34", family: 4 }, "IPv4 preferred over an AAAA answer for the pinned connection");
  await assert.rejects(guard.assertPublic("evil.example"), /non-public/);
  await assert.rejects(guard.assertPublic("evil.example"), /non-public/);
  assert.equal(lookups.length, 3, "negative result cached too");
  await assert.rejects(guard.assertPublic("nx.example"), /cannot resolve nx.example: ENOTFOUND/);
  await assert.rejects(guard.assertPublic("127.0.0.1"), /non-public address/);
  await assert.rejects(guard.assertPublic("[::1]"), /non-public address/);
  assert.deepEqual(await guard.assertPublic("8.8.8.8"), { address: "8.8.8.8", family: 4 });
  assert.deepEqual(await guard.assertPublic("[2606:4700::1111]"), { address: "2606:4700::1111", family: 6 });
  assert.equal(lookups.length, 4, "literals never hit DNS");
});

test("guardedFetch pins every hop to the address the guard vetted", async () => {
  const pins = [];
  const fetchImpl = async (url, init, pin) => { pins.push([url, pin]); return url.endsWith("/1") ? new Response(null, { status: 302, headers: { location: "https://b.example/2" } }) : new Response("ok"); };
  const guard = new HostGuard({ resolve: async (h) => [{ address: h === "a.example" ? "93.184.216.34" : "2606:4700::1111" }] });
  const r = await guardedFetch("https://a.example/1", {}, { fetchImpl, guard });
  assert.equal(r.res.status, 200);
  assert.deepEqual(pins, [["https://a.example/1", { address: "93.184.216.34", family: 4 }], ["https://b.example/2", { address: "2606:4700::1111", family: 6 }]]);
  const unguarded = []; await guardedFetch("https://a.example/2", {}, { fetchImpl: async (u, i, pin) => { unguarded.push(pin); return new Response("ok"); } });
  assert.deepEqual(unguarded, [{}], "no guard, no pin");
});

test("guardedFetch follows redirects by hand, re-checking the allowlist and the guard on every hop", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    assert.equal(init.redirect, "manual");
    if (url === "https://a.example/1") return new Response(null, { status: 302, headers: { location: "/2" } });
    if (url === "https://a.example/2") return new Response(null, { status: 301, headers: { location: "https://b.example/3" } });
    if (url === "https://a.example/private") return new Response(null, { status: 307, headers: { location: "https://internal.example/x" } });
    if (url === "https://a.example/loop") return new Response(null, { status: 302, headers: { location: "https://a.example/loop" } });
    return new Response("ok", { status: 200 });
  };
  const guard = new HostGuard({ resolve: async (h) => [{ address: h === "internal.example" ? "10.0.0.1" : "93.184.216.34" }] });
  const allow = (u) => !u.startsWith("https://b.example/");
  const r = await guardedFetch("https://a.example/1", {}, { fetchImpl, guard, allow: () => true });
  assert.equal(r.url, "https://b.example/3"); assert.equal(r.res.status, 200);
  await assert.rejects(guardedFetch("https://a.example/1", {}, { fetchImpl, guard, allow }), /blocked url https:\/\/b.example\/3/);
  await assert.rejects(guardedFetch("https://a.example/private", {}, { fetchImpl, guard }), /non-public/);
  await assert.rejects(guardedFetch("https://a.example/loop", {}, { fetchImpl, guard }), /too many redirects/);
  assert.ok(!seen.includes("https://internal.example/x"), "the private hop was never requested");
});
