import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nearToYocto, yoctoToNear } from "../src/amount.ts";

describe("nearToYocto", () => {
  it("converts exactly, with no float rounding", () => {
    assert.equal(nearToYocto("2"), "2000000000000000000000000");
    assert.equal(nearToYocto("2.5"), "2500000000000000000000000");
    // 0.1 + 0.2 style errors would show up here with floats.
    assert.equal(nearToYocto("0.3"), "300000000000000000000000");
    assert.equal(nearToYocto("1.000000000000000000000001"), "1000000000000000000000001");
    assert.equal(nearToYocto("123456789.123456789123456789123456"), "123456789123456789123456789123456");
    assert.equal(nearToYocto("0"), "0");
  });

  it("rejects anything that is not a plain decimal", () => {
    // More than 24 decimals would silently drop yocto; signs, exponents and blanks are not amounts.
    for (const bad of ["1.0000000000000000000000001", "-1", "+1", "1e3", "1.", ".5", "", " 1", "1,5", "0x10", "NaN", "Infinity", "1 000"]) {
      assert.throws(() => nearToYocto(bad), /decimal/, bad);
    }
  });
});

describe("yoctoToNear", () => {
  it("prints exact decimals without trailing zeros", () => {
    assert.equal(yoctoToNear("5000000000000000000000000"), "5");
    assert.equal(yoctoToNear("12500000000000000000000000"), "12.5");
    assert.equal(yoctoToNear("1"), "0.000000000000000000000001");
    assert.equal(yoctoToNear("0"), "0");
  });

  it("round-trips with nearToYocto", () => {
    for (const s of ["0.000000000000000000000001", "7.25", "10", "999999.999999"]) assert.equal(yoctoToNear(nearToYocto(s)), s);
  });
});
