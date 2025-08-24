// escrow.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface EscrowRecord {
  donor: string;
  recipient: string;
  amount: number;
  release_conditions: string[]; // Simplified to string array
  metadata: string;
  creation_time: number;
  expiry_time: number;
  released: boolean;
  refunded: boolean;
}

interface ContractState {
  paused: boolean;
  admin: string;
  total_escrows: number;
  total_released: number;
  total_refunded: number;
  escrows: Map<number, EscrowRecord>;
  escrow_balances: Map<number, number>;
  condition_verifiers: Map<string, string>;
  escrow_fulfillments: Map<string, boolean>; // Key: `${escrowId}-${condition}`
  escrow_auditors: Map<number, string[]>;
}

// Mock contract implementation
class EscrowMock {
  private state: ContractState = {
    paused: false,
    admin: "deployer",
    total_escrows: 0,
    total_released: 0,
    total_refunded: 0,
    escrows: new Map(),
    escrow_balances: new Map(),
    condition_verifiers: new Map(),
    escrow_fulfillments: new Map(),
    escrow_auditors: new Map(),
  };

  private MAX_CONDITIONS = 5;
  private MAX_METADATA_LEN = 500;
  private ERR_UNAUTHORIZED = 100;
  private ERR_INVALID_AMOUNT = 101;
  private ERR_INVALID_RECIPIENT = 102;
  private ERR_ESCROW_NOT_FOUND = 103;
  private ERR_ESCROW_ACTIVE = 104;
  private ERR_ESCROW_EXPIRED = 105;
  private ERR_CONDITIONS_NOT_MET = 106;
  private ERR_ALREADY_RELEASED = 107;
  private ERR_PAUSED = 108;
  private ERR_INVALID_DURATION = 109;
  private ERR_INVALID_CONDITION = 110;
  private ERR_MAX_CONDITIONS_EXCEEDED = 111;
  private ERR_INVALID_REFUND = 112;
  private ERR_NO_FUNDS = 113;
  private ERR_INSUFFICIENT_BALANCE = 114;
  private ERR_INVALID_METADATA = 115;

  private mockBlockHeight = 100; // Mock block height for testing

  // Helper to advance block height
  advanceBlockHeight(blocks: number) {
    this.mockBlockHeight += blocks;
  }

  setAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  addConditionVerifier(caller: string, condition: string, verifier: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.condition_verifiers.set(condition, verifier);
    return { ok: true, value: true };
  }

  createEscrow(
    caller: string,
    recipient: string,
    amount: number,
    conditions: string[],
    metadata: string,
    duration: number,
    auditors: string[]
  ): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (recipient === caller) {
      return { ok: false, value: this.ERR_INVALID_RECIPIENT };
    }
    if (conditions.length > this.MAX_CONDITIONS) {
      return { ok: false, value: this.ERR_MAX_CONDITIONS_EXCEEDED };
    }
    if (metadata.length > this.MAX_METADATA_LEN) {
      return { ok: false, value: this.ERR_INVALID_METADATA };
    }
    if (duration <= 0) {
      return { ok: false, value: this.ERR_INVALID_DURATION };
    }
    const escrowId = this.state.total_escrows + 1;
    const creationTime = this.mockBlockHeight;
    const expiryTime = creationTime + duration;
    this.state.escrows.set(escrowId, {
      donor: caller,
      recipient,
      amount,
      release_conditions: conditions,
      metadata,
      creation_time: creationTime,
      expiry_time: expiryTime,
      released: false,
      refunded: false,
    });
    this.state.escrow_balances.set(escrowId, amount);
    this.state.escrow_auditors.set(escrowId, auditors);
    this.state.total_escrows = escrowId;
    return { ok: true, value: escrowId };
  }

  fulfillCondition(caller: string, escrowId: number, condition: string): ClarityResponse<boolean> {
    const escrow = this.state.escrows.get(escrowId);
    if (!escrow) {
      return { ok: false, value: this.ERR_ESCROW_NOT_FOUND };
    }
    const verifier = this.state.condition_verifiers.get(condition);
    if (!verifier || caller !== verifier) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (escrow.released || escrow.refunded) {
      return { ok: false, value: this.ERR_ALREADY_RELEASED };
    }
    if (escrow.expiry_time <= this.mockBlockHeight) {
      return { ok: false, value: this.ERR_ESCROW_EXPIRED };
    }
    const key = `${escrowId}-${condition}`;
    this.state.escrow_fulfillments.set(key, true);
    return { ok: true, value: true };
  }

  releaseFunds(caller: string, escrowId: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const escrow = this.state.escrows.get(escrowId);
    if (!escrow) {
      return { ok: false, value: this.ERR_ESCROW_NOT_FOUND };
    }
    const balance = this.state.escrow_balances.get(escrowId);
    if (!balance) {
      return { ok: false, value: this.ERR_NO_FUNDS };
    }
    if (caller !== escrow.recipient && caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (escrow.released || escrow.refunded) {
      return { ok: false, value: this.ERR_ALREADY_RELEASED };
    }
    if (escrow.expiry_time <= this.mockBlockHeight) {
      return { ok: false, value: this.ERR_ESCROW_EXPIRED };
    }
    const allMet = escrow.release_conditions.every((cond) =>
      this.state.escrow_fulfillments.get(`${escrowId}-${cond}`)
    );
    if (!allMet) {
      return { ok: false, value: this.ERR_CONDITIONS_NOT_MET };
    }
    escrow.released = true;
    this.state.escrows.set(escrowId, escrow);
    this.state.escrow_balances.delete(escrowId);
    this.state.total_released += balance;
    return { ok: true, value: true };
  }

  refundFunds(caller: string, escrowId: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const escrow = this.state.escrows.get(escrowId);
    if (!escrow) {
      return { ok: false, value: this.ERR_ESCROW_NOT_FOUND };
    }
    const balance = this.state.escrow_balances.get(escrowId);
    if (!balance) {
      return { ok: false, value: this.ERR_NO_FUNDS };
    }
    if (caller !== escrow.donor) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (escrow.released || escrow.refunded) {
      return { ok: false, value: this.ERR_ALREADY_RELEASED };
    }
    if (escrow.expiry_time > this.mockBlockHeight) {
      return { ok: false, value: this.ERR_ESCROW_ACTIVE };
    }
    escrow.refunded = true;
    this.state.escrows.set(escrowId, escrow);
    this.state.escrow_balances.delete(escrowId);
    this.state.total_refunded += balance;
    return { ok: true, value: true };
  }

  addAuditor(caller: string, escrowId: number, auditor: string): ClarityResponse<boolean> {
    const escrow = this.state.escrows.get(escrowId);
    if (!escrow) {
      return { ok: false, value: this.ERR_ESCROW_NOT_FOUND };
    }
    const auditors = this.state.escrow_auditors.get(escrowId) || [];
    if (caller !== escrow.donor) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (auditors.length >= 3) {
      return { ok: false, value: this.ERR_MAX_CONDITIONS_EXCEEDED };
    }
    auditors.push(auditor);
    this.state.escrow_auditors.set(escrowId, auditors);
    return { ok: true, value: true };
  }

  getEscrowDetails(escrowId: number): ClarityResponse<EscrowRecord | undefined> {
    return { ok: true, value: this.state.escrows.get(escrowId) };
  }

  getEscrowBalance(escrowId: number): ClarityResponse<number | undefined> {
    return { ok: true, value: this.state.escrow_balances.get(escrowId) };
  }

  isConditionFulfilled(escrowId: number, condition: string): ClarityResponse<boolean | undefined> {
    const key = `${escrowId}-${condition}`;
    return { ok: true, value: this.state.escrow_fulfillments.get(key) };
  }

  getConditionVerifier(condition: string): ClarityResponse<string | undefined> {
    return { ok: true, value: this.state.condition_verifiers.get(condition) };
  }

  getTotalEscrows(): ClarityResponse<number> {
    return { ok: true, value: this.state.total_escrows };
  }

  getTotalReleased(): ClarityResponse<number> {
    return { ok: true, value: this.state.total_released };
  }

  getTotalRefunded(): ClarityResponse<number> {
    return { ok: true, value: this.state.total_refunded };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getAdmin(): ClarityResponse<string> {
    return { ok: true, value: this.state.admin };
  }

  getEscrowAuditors(escrowId: number): ClarityResponse<string[] | undefined> {
    return { ok: true, value: this.state.escrow_auditors.get(escrowId) };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  donor: "wallet_1",
  recipient: "wallet_2",
  verifier: "wallet_3",
  auditor: "wallet_4",
};

describe("Escrow Contract", () => {
  let contract: EscrowMock;

  beforeEach(() => {
    contract = new EscrowMock();
    vi.resetAllMocks();
  });

  it("should allow admin to set new admin", () => {
    const result = contract.setAdmin(accounts.deployer, accounts.donor);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getAdmin()).toEqual({ ok: true, value: accounts.donor });
  });

  it("should prevent non-admin from setting admin", () => {
    const result = contract.setAdmin(accounts.recipient, accounts.donor);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should allow admin to pause and unpause contract", () => {
    let result = contract.pauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    result = contract.unpauseContract(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should allow admin to add condition verifier", () => {
    const result = contract.addConditionVerifier(accounts.deployer, "verified-enrollment", accounts.verifier);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getConditionVerifier("verified-enrollment")).toEqual({ ok: true, value: accounts.verifier });
  });

  it("should create a new escrow", () => {
    const conditions = ["verified-enrollment"];
    const auditors = [accounts.auditor];
    const result = contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      conditions,
      "Aid for school supplies",
      100,
      auditors
    );
    expect(result).toEqual({ ok: true, value: 1 });
    const details = contract.getEscrowDetails(1);
    expect(details).toEqual({
      ok: true,
      value: expect.objectContaining({
        donor: accounts.donor,
        recipient: accounts.recipient,
        amount: 1000,
        release_conditions: conditions,
        metadata: "Aid for school supplies",
        released: false,
        refunded: false,
      }),
    });
    expect(contract.getEscrowBalance(1)).toEqual({ ok: true, value: 1000 });
    expect(contract.getTotalEscrows()).toEqual({ ok: true, value: 1 });
    expect(contract.getEscrowAuditors(1)).toEqual({ ok: true, value: auditors });
  });

  it("should prevent creating escrow with invalid amount", () => {
    const result = contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      0,
      [],
      "Invalid",
      100,
      []
    );
    expect(result).toEqual({ ok: false, value: 101 });
  });

  it("should allow verifier to fulfill condition", () => {
    contract.addConditionVerifier(accounts.deployer, "verified-enrollment", accounts.verifier);
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      ["verified-enrollment"],
      "Test",
      100,
      []
    );
    const result = contract.fulfillCondition(accounts.verifier, 1, "verified-enrollment");
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.isConditionFulfilled(1, "verified-enrollment")).toEqual({ ok: true, value: true });
  });

  it("should prevent unauthorized fulfillment", () => {
    contract.addConditionVerifier(accounts.deployer, "verified-enrollment", accounts.verifier);
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      ["verified-enrollment"],
      "Test",
      100,
      []
    );
    const result = contract.fulfillCondition(accounts.donor, 1, "verified-enrollment");
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should release funds when conditions met", () => {
    contract.addConditionVerifier(accounts.deployer, "verified-enrollment", accounts.verifier);
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      ["verified-enrollment"],
      "Test",
      100,
      []
    );
    contract.fulfillCondition(accounts.verifier, 1, "verified-enrollment");
    const result = contract.releaseFunds(accounts.recipient, 1);
    expect(result).toEqual({ ok: true, value: true });
    const details = contract.getEscrowDetails(1);
    expect(details.value?.released).toBe(true);
    expect(contract.getEscrowBalance(1)).toEqual({ ok: true, value: undefined });
    expect(contract.getTotalReleased()).toEqual({ ok: true, value: 1000 });
  });

  it("should prevent release without conditions met", () => {
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      ["verified-enrollment"],
      "Test",
      100,
      []
    );
    const result = contract.releaseFunds(accounts.recipient, 1);
    expect(result).toEqual({ ok: false, value: 106 });
  });

  it("should allow refund after expiry", () => {
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      [],
      "Test",
      100,
      []
    );
    contract.advanceBlockHeight(101);
    const result = contract.refundFunds(accounts.donor, 1);
    expect(result).toEqual({ ok: true, value: true });
    const details = contract.getEscrowDetails(1);
    expect(details.value?.refunded).toBe(true);
    expect(contract.getEscrowBalance(1)).toEqual({ ok: true, value: undefined });
    expect(contract.getTotalRefunded()).toEqual({ ok: true, value: 1000 });
  });

  it("should prevent refund before expiry", () => {
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      [],
      "Test",
      100,
      []
    );
    const result = contract.refundFunds(accounts.donor, 1);
    expect(result).toEqual({ ok: false, value: 104 });
  });

  it("should allow adding auditor", () => {
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      [],
      "Test",
      100,
      []
    );
    const result = contract.addAuditor(accounts.donor, 1, accounts.auditor);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.getEscrowAuditors(1)).toEqual({ ok: true, value: [accounts.auditor] });
  });

  it("should prevent non-donor from adding auditor", () => {
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      [],
      "Test",
      100,
      []
    );
    const result = contract.addAuditor(accounts.recipient, 1, accounts.auditor);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should enforce max auditors", () => {
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      [],
      "Test",
      100,
      [accounts.auditor, "auditor2", "auditor3"]
    );
    const result = contract.addAuditor(accounts.donor, 1, "auditor4");
    expect(result).toEqual({ ok: false, value: 111 });
  });

  it("should prevent operations when paused", () => {
    contract.pauseContract(accounts.deployer);
    const createResult = contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      [],
      "Test",
      100,
      []
    );
    expect(createResult).toEqual({ ok: false, value: 108 });

    // Setup for other functions
    contract.unpauseContract(accounts.deployer);
    contract.createEscrow(
      accounts.donor,
      accounts.recipient,
      1000,
      [],
      "Test",
      100,
      []
    );
    contract.pauseContract(accounts.deployer);

    const releaseResult = contract.releaseFunds(accounts.recipient, 1);
    expect(releaseResult).toEqual({ ok: false, value: 108 });

    const refundResult = contract.refundFunds(accounts.donor, 1);
    expect(refundResult).toEqual({ ok: false, value: 108 });
  });
});