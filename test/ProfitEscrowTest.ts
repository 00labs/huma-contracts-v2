import { ethers } from "hardhat";

import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    FirstLossCover,
    MockPoolCredit,
    MockToken,
    PoolFeeManager,
    Pool,
    PoolConfig,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
    ProfitEscrow,
} from "../typechain-types";
import { toToken } from "./TestUtils";
import { BigNumber as BN } from "ethers";
import { expect } from "chai";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    evaluationAgent2: SignerWithAddress,
    poolOperator: SignerWithAddress,
    protocolTreasury: SignerWithAddress,
    lender1: SignerWithAddress,
    borrower: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverProfitEscrowContract: ProfitEscrow,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager;

describe("PoolSafe Tests", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            protocolTreasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            evaluationAgent2,
            poolOperator,
            lender1,
            borrower,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            protocolTreasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
        );

        [
            poolConfigContract,
            poolFeeManagerContract,
            poolSafeContract,
            calendarContract,
            borrowerFirstLossCoverContract,
            affiliateFirstLossCoverContract,
            affiliateFirstLossCoverProfitEscrowContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditFeeManagerContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender1],
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("ProfitEscrow Tests", function () {
        let profitEscrowContract: ProfitEscrow;

        async function deployContract() {
            // Deploy a new profit escrow contract to eliminate any prior deposits made during test setup
            // and make the tests easier to reason about and debug.
            const ProfitEscrow = await ethers.getContractFactory("ProfitEscrow");
            profitEscrowContract = await ProfitEscrow.deploy();
            await profitEscrowContract.deployed();
            await profitEscrowContract["initialize(address,address)"](
                defaultDeployer.getAddress(),
                poolConfigContract.address,
            );
            await poolConfigContract.connect(poolOwner).setFirstLossCover(
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                affiliateFirstLossCoverContract.address,
                {
                    coverRateInBps: 0,
                    coverCap: 0,
                    liquidityCap: 0,
                    maxPercentOfPoolValueInBps: 0,
                    riskYieldMultiplier: 0,
                },
                profitEscrowContract.address,
            );
        }

        beforeEach(async function () {
            await loadFixture(deployContract);
        });

        describe("Happy path e2e tests", function () {
            async function deposit(account: SignerWithAddress, amount: BN) {
                await expect(profitEscrowContract.deposit(account.getAddress(), amount))
                    .to.emit(profitEscrowContract, "PrincipalDeposited")
                    .withArgs(await account.getAddress(), amount);
            }

            async function withdraw(account: SignerWithAddress, amount: BN) {
                await expect(profitEscrowContract.withdraw(account.getAddress(), amount))
                    .to.emit(profitEscrowContract, "PrincipalWithdrawn")
                    .withArgs(await account.getAddress(), amount);
            }

            async function addProfit(amount: BN, expectedAccProfitPerShare: BN) {
                await expect(profitEscrowContract.addProfit(amount))
                    .to.emit(profitEscrowContract, "ProfitAdded")
                    .withArgs(amount, expectedAccProfitPerShare);
            }

            async function claim(account: SignerWithAddress, amount: BN) {
                const oldAmountClaimable = await profitEscrowContract.claimable(
                    account.getAddress(),
                );
                const oldPoolSafeBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                const oldUserBalance = await mockTokenContract.balanceOf(account.getAddress());

                await expect(profitEscrowContract.connect(account).claim(amount))
                    .to.emit(profitEscrowContract, "ProfitClaimed")
                    .withArgs(await account.getAddress(), amount);
                expect(await profitEscrowContract.claimable(account.getAddress())).to.equal(
                    oldAmountClaimable.sub(amount),
                );
                const newPoolSafeBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(newPoolSafeBalance).to.equal(oldPoolSafeBalance.sub(amount));
                const newUserBalance = await mockTokenContract.balanceOf(account.getAddress());
                expect(newUserBalance).to.equal(oldUserBalance.add(amount));
            }

            describe("When there is only one user", function () {
                it("Should allow the user to deposit once, add profit once, claim multiple times and withdraw once", async function () {
                    // Deposit.
                    const principal = toToken(10_000);
                    await deposit(evaluationAgent, principal);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(0);

                    // Add profit.
                    const profit = toToken(1_000);
                    const expectedAccProfitPerShare = profit
                        .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                        .div(principal);
                    await addProfit(profit, expectedAccProfitPerShare);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(
                        principal
                            .mul(profit)
                            .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                            .div(principal)
                            .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
                    );

                    // Claim.
                    const amountToClaim = toToken(300);
                    await claim(evaluationAgent, amountToClaim);
                    const remainingAmountToClaim = profit.sub(amountToClaim);
                    await claim(evaluationAgent, remainingAmountToClaim);

                    // Withdraw.
                    await withdraw(evaluationAgent, principal);
                });

                it("Should allow the user to deposit once, add profit once, withdraw once and claim multiple times", async function () {
                    // Deposit.
                    const principal = toToken(10_000);
                    await deposit(evaluationAgent, principal);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(0);

                    // Add profit.
                    const profit = toToken(1_000);
                    const expectedAccProfitPerShare = profit
                        .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                        .div(principal);
                    await addProfit(profit, expectedAccProfitPerShare);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(
                        principal
                            .mul(profit)
                            .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                            .div(principal)
                            .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
                    );

                    // Withdraw.
                    await withdraw(evaluationAgent, principal);

                    // Claim.
                    const amountToClaim = toToken(300);
                    await claim(evaluationAgent, amountToClaim);
                    const remainingAmountToClaim = profit.sub(amountToClaim);
                    await claim(evaluationAgent, remainingAmountToClaim);
                });

                it("Should allow the user to deposit, add profit, claim and withdraw multiple times", async function () {
                    // Deposit.
                    const principal1 = toToken(10_000);
                    await deposit(evaluationAgent, principal1);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(0);

                    // Add profit.
                    const profit1 = toToken(1_000);
                    let expectedAccProfitPerShare = profit1
                        .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                        .div(principal1);
                    await addProfit(profit1, expectedAccProfitPerShare);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(profit1);

                    // Deposit more.
                    const principal2 = toToken(8_765);
                    await deposit(evaluationAgent, principal2);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(profit1);

                    // Add more profit.
                    const profit2 = toToken(2_987);
                    expectedAccProfitPerShare = expectedAccProfitPerShare.add(
                        profit2
                            .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                            .div(principal1.add(principal2)),
                    );
                    await addProfit(profit2, expectedAccProfitPerShare);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.be.closeTo(profit1.add(profit2), 1);

                    // And even more profit.
                    const profit3 = toToken(3_999);
                    expectedAccProfitPerShare = expectedAccProfitPerShare.add(
                        profit3
                            .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                            .div(principal1.add(principal2)),
                    );
                    await addProfit(profit3, expectedAccProfitPerShare);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.be.closeTo(profit1.add(profit2).add(profit3), 1);

                    // Claim.
                    const amountToClaim1 = toToken(1_492);
                    await claim(evaluationAgent, amountToClaim1);

                    // Withdraw.
                    const amountToWithdraw1 = toToken(9_319);
                    await withdraw(evaluationAgent, amountToWithdraw1);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.be.closeTo(profit1.add(profit2).add(profit3).sub(amountToClaim1), 1);

                    // Withdraw the rest.
                    const amountToWithdraw2 = principal1.add(principal2).sub(amountToWithdraw1);
                    await withdraw(evaluationAgent, amountToWithdraw2);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.be.closeTo(profit1.add(profit2).add(profit3).sub(amountToClaim1), 1);

                    // Claim the rest.
                    const amountToClaim2 = profit1
                        .add(profit2)
                        .add(profit3)
                        .sub(amountToClaim1)
                        .sub(1); // sub(1) to account for the previous discrepancy in claimable amount caused by truncation.
                    await claim(evaluationAgent, amountToClaim2);
                });
            });

            describe("When there are multiple users", function () {
                it("Should allow each user to claim profit proportional to their principal contribution", async function () {
                    // Deposit.
                    const principal = toToken(10_000);
                    await deposit(evaluationAgent, principal);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(0);
                    const principal2 = toToken(50_000);
                    await deposit(evaluationAgent2, principal2);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent2.getAddress()),
                    ).to.equal(0);

                    // Add profit.
                    const profit = toToken(1_000);
                    const totalPrincipal = principal.add(principal2);
                    const expectedAccProfitPerShare = profit
                        .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                        .div(totalPrincipal);
                    await addProfit(profit, expectedAccProfitPerShare);
                    const claimable = profit.mul(principal).div(totalPrincipal),
                        claimable2 = profit.mul(principal2).div(totalPrincipal);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(claimable);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent2.getAddress()),
                    ).to.equal(claimable2);

                    // Claim.
                    await claim(evaluationAgent, claimable);
                    await claim(evaluationAgent2, claimable2);

                    // Withdraw.
                    await withdraw(evaluationAgent, principal);
                    await withdraw(evaluationAgent2, principal2);
                });

                it("Should only allow each user to claim profits generated after they deposit", async function () {
                    // Deposit.
                    const principal = toToken(10_000);
                    await deposit(evaluationAgent, principal);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(0);

                    // Add profit.
                    const profit = toToken(1_000);
                    let expectedAccProfitPerShare = profit
                        .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                        .div(principal);
                    await addProfit(profit, expectedAccProfitPerShare);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(profit);

                    // evaluationAgent2 deposits.
                    const principal2 = toToken(50_000);
                    await deposit(evaluationAgent2, principal2);
                    // evaluationAgent2 is not eligible to claim any profit generated before their deposit.
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent2.getAddress()),
                    ).to.equal(0);

                    // Add more profit.
                    const profit2 = toToken(1_000);
                    expectedAccProfitPerShare = expectedAccProfitPerShare.add(
                        profit2
                            .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                            .div(principal.add(principal2)),
                    );
                    await addProfit(profit2, expectedAccProfitPerShare);
                    const totalPrincipal = principal.add(principal2);
                    // evaluationAgent is eligible to claim all of `profit`, plus a proportion of `profit2`.
                    const claimable = profit.add(profit2.mul(principal).div(totalPrincipal));
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(claimable);
                    // evaluationAgent2 is only eligible to claim the rest of `profit2`.
                    const claimable2 = profit2.mul(principal2).div(totalPrincipal);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent2.getAddress()),
                    ).to.equal(claimable2);

                    // Claim.
                    await claim(evaluationAgent, claimable);
                    await claim(evaluationAgent2, claimable2);

                    // Withdraw.
                    await withdraw(evaluationAgent, principal);
                    await withdraw(evaluationAgent2, principal2);
                });

                it("Should only allow each user to claim profits generated before they withdraw", async function () {
                    // Deposit.
                    const principal = toToken(10_000);
                    await deposit(evaluationAgent, principal);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(0);

                    // Add profit.
                    const profit = toToken(1_000);
                    let expectedAccProfitPerShare = profit
                        .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                        .div(principal);
                    await addProfit(profit, expectedAccProfitPerShare);
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(profit);

                    // evaluationAgent2 deposits.
                    const principal2 = toToken(50_000);
                    await deposit(evaluationAgent2, principal2);
                    // evaluationAgent2 is not eligible to claim any profit generated before their deposit.
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent2.getAddress()),
                    ).to.equal(0);

                    // evaluationAgent withdraws.
                    await withdraw(evaluationAgent, principal);

                    // Add more profit, which is entitled only to evaluationAgent2.
                    const profit2 = toToken(1_000);
                    expectedAccProfitPerShare = expectedAccProfitPerShare.add(
                        profit2.mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR).div(principal2),
                    );
                    await addProfit(profit2, expectedAccProfitPerShare);
                    // evaluationAgent is eligible to claim all of `profit`.
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent.getAddress()),
                    ).to.equal(profit);
                    // evaluationAgent2 is eligible to claim all of `profit2`.
                    expect(
                        await profitEscrowContract.claimable(evaluationAgent2.getAddress()),
                    ).to.equal(profit2);

                    // evaluationAgent2 withdraw2.
                    await withdraw(evaluationAgent2, principal2);

                    // Claim.
                    await claim(evaluationAgent, profit);
                    await claim(evaluationAgent2, profit2);
                });
            });
        });

        describe("Error cases", function () {
            let amount: BN;

            before(function () {
                amount = toToken(1_000);
            });

            describe("addProfit", function () {
                it("Should disallow 0 as the amount of profit", async function () {
                    await expect(profitEscrowContract.addProfit(0)).to.be.revertedWithCustomError(
                        profitEscrowContract,
                        "zeroAmountProvided",
                    );
                });

                it("Should disallow non-controllers to add profit", async function () {
                    await expect(
                        profitEscrowContract.connect(lender1).addProfit(amount),
                    ).to.be.revertedWithCustomError(profitEscrowContract, "todo");
                });
            });

            describe("deposit", function () {
                it("Should disallow 0 as the amount of deposit", async function () {
                    await expect(
                        profitEscrowContract.deposit(evaluationAgent.getAddress(), 0),
                    ).to.be.revertedWithCustomError(profitEscrowContract, "zeroAmountProvided");
                });

                it("Should disallow 0 as the depositor address", async function () {
                    await expect(
                        profitEscrowContract.deposit(ethers.constants.AddressZero, amount),
                    ).to.be.revertedWithCustomError(profitEscrowContract, "zeroAddressProvided");
                });

                it("Should disallow non-controllers to deposit", async function () {
                    await expect(
                        profitEscrowContract
                            .connect(lender1)
                            .deposit(evaluationAgent.getAddress(), amount),
                    ).to.be.revertedWithCustomError(profitEscrowContract, "todo");
                });
            });

            describe("withdraw", function () {
                it("Should disallow 0 as the amount of withdrawal", async function () {
                    await expect(
                        profitEscrowContract.withdraw(evaluationAgent.getAddress(), 0),
                    ).to.be.revertedWithCustomError(profitEscrowContract, "zeroAmountProvided");
                });

                it("Should disallow 0 as the address", async function () {
                    await expect(
                        profitEscrowContract.withdraw(ethers.constants.AddressZero, amount),
                    ).to.be.revertedWithCustomError(profitEscrowContract, "zeroAddressProvided");
                });

                it("Should disallow non-controllers to withdraw", async function () {
                    await expect(
                        profitEscrowContract
                            .connect(lender1)
                            .withdraw(evaluationAgent.getAddress(), amount),
                    ).to.be.revertedWithCustomError(profitEscrowContract, "todo");
                });
            });

            describe("claim", function () {
                it("Should disallow 0 as the amount to claim", async function () {
                    await expect(
                        profitEscrowContract.connect(evaluationAgent).claim(0),
                    ).to.be.revertedWithCustomError(profitEscrowContract, "zeroAmountProvided");
                });

                it("Should disallow the user to claim more than they own", async function () {
                    await expect(
                        profitEscrowContract.connect(evaluationAgent).claim(amount),
                    ).to.be.revertedWithCustomError(profitEscrowContract, "todo");
                });
            });
        });
    });
});
