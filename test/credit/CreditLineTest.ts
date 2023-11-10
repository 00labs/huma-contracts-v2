import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../typechain-types";
import {
    CreditConfigStructOutput,
    CreditRecordStructOutput,
} from "../../typechain-types/contracts/credit/Credit";
import {
    CONSTANTS,
    CreditState,
    checkCreditConfig,
    checkCreditRecord,
    checkTwoCreditRecords,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    printCreditRecord,
} from "../BaseTest";
import {
    borrowerLevelCreditHash,
    getFutureBlockTime,
    getMinFirstLossCoverRequirement,
    getNextDueDate,
    getStartDateOfPeriod,
    mineNextBlockWithTimestamp,
    toToken,
} from "../TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress, borrower: SignerWithAddress, borrower2: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine,
    creditDueManagerContract: CreditDueManager;

function calcDefaultDate(cr: CreditRecordStructOutput, defaultPeriod: number): number {
    let [defaultDate] = getNextDueDate(
        cr.nextDueDate.toNumber(),
        cr.nextDueDate.toNumber(),
        defaultPeriod,
    );
    return defaultDate;
}

function calcProfitRateWithCR(cr: CreditRecordStructOutput, yieldInBps: number): BN {
    let principal = getPrincipal(cr);
    return calcProfitRateWithPrincipal(principal, yieldInBps);
}

function calcProfitRateWithPrincipal(principal: BN, yieldInBps: number): BN {
    return principal
        .mul(BN.from(yieldInBps))
        .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
        .div(CONSTANTS.BP_FACTOR.mul(CONSTANTS.SECONDS_IN_YEAR));
}

function calcYield(principal: BN, yieldInBps: number, seconds: number): BN {
    return principal
        .mul(BN.from(yieldInBps))
        .mul(BN.from(seconds))
        .div(BN.from(CONSTANTS.SECONDS_IN_YEAR).mul(CONSTANTS.BP_FACTOR));
}

function calcLateFee(configs: BN[], principal: BN): BN {
    let fees = configs[0];
    // todo this implementation needs to be changed to reflect the new late fee policy
    if (configs[1].gt(0)) {
        fees = fees.add(principal.mul(configs[1]).div(CONSTANTS.BP_FACTOR));
    }
    return fees;
}

function getPrincipal(cr: CreditRecordStructOutput): BN {
    return cr.unbilledPrincipal.add(cr.nextDue.sub(cr.yieldDue));
}

function calcLateCreditRecord(
    cr: CreditRecordStructOutput,
    cc: CreditConfigStructOutput,
    periodCount: number,
    currentTime: number,
    configs: BN[],
): [CreditRecordStructOutput, BN, BN] {
    let ncr = { ...cr };
    let principalDiff = BN.from(0);
    let missProfit = BN.from(0);
    let preDueDate = 0;

    // console.log(`currentTime: ${currentTime}`);

    for (let i = 0; i < periodCount; i++) {
        let [nextDueDate] = getNextDueDate(
            ncr.nextDueDate.toNumber(),
            ncr.nextDueDate.toNumber(),
            cc.periodDuration,
        );
        let seconds = nextDueDate - ncr.nextDueDate.toNumber();

        // console.log(`nextDueDate: ${nextDueDate}, seconds: ${seconds}`);

        // console.log(
        //     `ncr.nextDue: ${ncr.nextDue}, ncr.unbilledPrincipal: ${ncr.unbilledPrincipal}`,
        // );

        if (ncr.nextDue.gt(BN.from(0))) {
            ncr.unbilledPrincipal = ncr.unbilledPrincipal.add(ncr.nextDue);
            principalDiff = principalDiff.add(ncr.nextDue);
        }

        ncr.yieldDue = calcYield(ncr.unbilledPrincipal, cc.yieldInBps, seconds);

        // console.log(`ncr.yieldDue: ${ncr.yieldDue}`);

        let principalToBill = ncr.unbilledPrincipal.mul(configs[3]).div(CONSTANTS.BP_FACTOR);
        ncr.nextDue = ncr.yieldDue.add(principalToBill);
        ncr.unbilledPrincipal = ncr.unbilledPrincipal.sub(principalToBill);

        // console.log(
        //     `ncr.nextDue: ${ncr.nextDue}, ncr.unbilledPrincipal: ${ncr.unbilledPrincipal}, principalDiff: ${principalDiff}`,
        // );

        if (principalDiff.gt(BN.from(0)) && currentTime > nextDueDate) {
            missProfit = missProfit.add(calcYield(principalDiff, cc.yieldInBps, seconds));
            // console.log(`missProfit: ${missProfit}`);
        }

        preDueDate = ncr.nextDueDate.toNumber();
        ncr.nextDueDate = BN.from(nextDueDate);
    }
    if (currentTime > preDueDate) {
        missProfit = missProfit.add(
            calcYield(principalDiff, cc.yieldInBps, currentTime - preDueDate),
        );
        // console.log(`missProfit: ${missProfit}`);
    }

    ncr.remainingPeriods = ncr.remainingPeriods - periodCount;
    ncr.missedPeriods = ncr.missedPeriods + periodCount;

    if (ncr.remainingPeriods === 0) {
        ncr.nextDue = ncr.nextDue.add(ncr.unbilledPrincipal);
        ncr.unbilledPrincipal = BN.from(0);
    }

    ncr.state = 5;

    return [ncr, principalDiff, missProfit];
}

async function getCreditRecordSettings(): Promise<BN[]> {
    let settings = Array<BN>();
    let fees = await poolConfigContract.getFees();
    settings.push(fees[0]);
    settings.push(fees[1]);
    settings.push(fees[2]);
    settings.push(await poolConfigContract.getMinPrincipalRateInBps());
    return settings;
}

describe("CreditLine Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            lender,
            borrower,
            borrower2,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
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
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditDueManagerContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "CreditLine",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, borrower, borrower2],
        );

        await borrowerFirstLossCoverContract
            .connect(poolOwner)
            .setCoverProvider(borrower.address, {
                poolCapCoverageInBps: 1,
                poolValueCoverageInBps: 100,
            });
        await mockTokenContract
            .connect(borrower)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);
        await borrowerFirstLossCoverContract
            .connect(borrower)
            .depositCover(
                await getMinFirstLossCoverRequirement(
                    borrowerFirstLossCoverContract,
                    poolConfigContract,
                    poolContract,
                    borrower.address,
                ),
            );

        await borrowerFirstLossCoverContract
            .connect(poolOwner)
            .setCoverProvider(borrower2.address, {
                poolCapCoverageInBps: 1,
                poolValueCoverageInBps: 100,
            });
        await mockTokenContract
            .connect(borrower2)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);
        await borrowerFirstLossCoverContract
            .connect(borrower2)
            .depositCover(
                await getMinFirstLossCoverRequirement(
                    borrowerFirstLossCoverContract,
                    poolConfigContract,
                    poolContract,
                    borrower2.address,
                ),
            );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("refreshCredit", function () {
        // TODO(jiatu): fill this in
    });

    describe("triggerDefault", function () {
        // TODO(jiatu): fill this in
    });

    describe("closeCredit", function () {
        describe("When the credit is not approved yet", function () {
            it("Should not be able to close a non-existent credit", async function () {
                await expect(
                    creditContract.connect(borrower).closeCredit(borrower.getAddress()),
                ).to.be.revertedWithCustomError(creditContract, "notBorrowerOrEA");
            });
        });

        describe("When the credit has been approved", function () {
            let creditHash: string;

            async function approveCredit(
                remainingPeriods: number = 1,
                committedAmount: BN = BN.from(0),
            ) {
                creditHash = await borrowerLevelCreditHash(creditContract, borrower);
                await creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        remainingPeriods,
                        1_000,
                        committedAmount,
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            async function testCloseCredit(actor: SignerWithAddress) {
                await creditContract.connect(actor).closeCredit(borrower.getAddress());

                // Make sure relevant fields have been reset.
                const creditRecord = await creditContract.getCreditRecord(creditHash);
                expect(creditRecord.state).to.equal(CreditState.Deleted);
                expect(creditRecord.remainingPeriods).to.equal(ethers.constants.Zero);
                const creditConfig = await creditContract.getCreditConfig(creditHash);
                expect(creditConfig.creditLimit).to.equal(ethers.constants.Zero);
            }

            async function testCloseCreditReversion(actor: SignerWithAddress, errorName: string) {
                const oldCreditConfig = await creditContract.getCreditConfig(creditHash);
                const oldCreditRecord = await creditContract.getCreditRecord(creditHash);
                await expect(
                    creditContract.connect(actor).closeCredit(borrower.getAddress()),
                ).to.be.revertedWithCustomError(creditContract, errorName);

                // Make sure neither credit config nor credit record has changed.
                const newCreditConfig = await creditContract.getCreditConfig(creditHash);
                checkCreditConfig(
                    newCreditConfig,
                    oldCreditConfig.creditLimit,
                    oldCreditConfig.committedAmount,
                    oldCreditConfig.periodDuration,
                    oldCreditConfig.numOfPeriods,
                    oldCreditConfig.yieldInBps,
                    oldCreditConfig.revolving,
                    oldCreditConfig.receivableBacked,
                    oldCreditConfig.borrowerLevelCredit,
                    oldCreditConfig.exclusive,
                );
                const newCreditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    newCreditRecord,
                    oldCreditRecord.unbilledPrincipal,
                    oldCreditRecord.nextDueDate,
                    oldCreditRecord.nextDue,
                    oldCreditRecord.yieldDue,
                    oldCreditRecord.missedPeriods,
                    oldCreditRecord.remainingPeriods,
                    oldCreditRecord.state,
                );
            }

            // TODO(jiatu): test event emission.
            it("Should allow the borrower to close a newly approved credit", async function () {
                await testCloseCredit(borrower);
            });

            it("Should allow the evaluation agent to close a newly approved credit", async function () {
                await testCloseCredit(eaServiceAccount);
            });

            it("Should allow the borrower to close a credit that's fully paid back", async function () {
                const amount = toToken(1_000);
                await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                const creditRecord = await creditContract.getCreditRecord(creditHash);
                await creditContract
                    .connect(borrower)
                    .makePayment(
                        borrower.getAddress(),
                        creditRecord.nextDue.add(creditRecord.unbilledPrincipal),
                    );
                await testCloseCredit(borrower);
            });

            it("Should allow the borrower to close a credit that has commitment but has reached maturity", async function () {
                // Close the approved credit then open a new one with a different committed amount.
                await creditContract.connect(borrower).closeCredit(borrower.getAddress());
                await approveCredit(1, toToken(100_000));
                // Make one round of drawdown and payment so that the borrower have a credit record.
                const amount = toToken(1_000);
                await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                let creditRecord = await creditContract.getCreditRecord(creditHash);
                await creditContract
                    .connect(borrower)
                    .makePayment(
                        borrower.getAddress(),
                        creditRecord.nextDue.add(creditRecord.unbilledPrincipal),
                    );

                // Advance one block so that the remaining period becomes 0.
                const creditConfig = await creditContract.getCreditConfig(creditHash);
                // TODO: there is some issues with date calculation when a billing cycle starts in the middle of
                // of a period, hence the multiplication with 4. Technically speaking we don't need it.
                const nextBlockTime = await getFutureBlockTime(
                    4 *
                        creditConfig.periodDuration *
                        CONSTANTS.SECONDS_IN_A_DAY *
                        CONSTANTS.DAYS_IN_A_MONTH,
                );
                await mineNextBlockWithTimestamp(nextBlockTime);
                // Make another payment because there is yield due from commitment.
                await creditContract.refreshCredit(borrower.getAddress());
                creditRecord = await creditContract.getCreditRecord(creditHash);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), creditRecord.nextDue);
                await testCloseCredit(borrower);
            });

            it("Should not allow the borrower to close a credit that has upcoming yield due", async function () {
                const amount = toToken(1_000);
                await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                // Only pay back the total principal outstanding.
                const creditRecord = await creditContract.getCreditRecord(creditHash);
                const totalPrincipal = creditRecord.nextDue
                    .sub(creditRecord.yieldDue)
                    .add(creditRecord.unbilledPrincipal);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), totalPrincipal);
                await testCloseCreditReversion(borrower, "creditLineHasOutstandingBalance");
            });

            it("Should not allow the borrower to close a credit that has past due", async function () {
                // TODO(jiatu): fill this in after checking whether the past due logic is correct.
                // const amount = toToken(1_000);
                // await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                //
                // // Advance one block so that all due becomes past due.
                // const creditConfig = await creditContract.getCreditConfig(creditHash);
                // const nextBlockTime = await getFutureBlockTime(4 * creditConfig.periodDuration * CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH);
                // await mineNextBlockWithTimestamp(nextBlockTime);
                // await creditContract.refreshCredit(borrower.getAddress());
                // const creditRecord = await creditContract.getCreditRecord(creditHash);
                // // expect(creditRecord.nextDue).to.equal(ethers.constants.Zero);
                // expect(creditRecord.totalPastDue).to.be.greaterThan(ethers.constants.Zero);
                // expect(creditRecord.unbilledPrincipal).to.equal(ethers.constants.Zero);
                // await testCloseCreditReversion(borrower, "creditLineHasOutstandingBalance");
            });

            it("Should not allow the borrower to close a credit that has outstanding unbilled principal", async function () {
                const amount = toToken(1_000);
                await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                // Only pay back the next due and have unbilled principal outstanding.
                const creditRecord = await creditContract.getCreditRecord(creditHash);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), creditRecord.nextDue);
                await testCloseCreditReversion(borrower, "creditLineHasOutstandingBalance");
            });

            it("Should not allow the borrower to close a credit that has unfulfilled commitment", async function () {
                // Close the approved credit then open a new one with a different committed amount.
                await creditContract.connect(borrower).closeCredit(borrower.getAddress());
                await approveCredit(3, toToken(100_000));
                await testCloseCreditReversion(borrower, "creditLineHasUnfulfilledCommitment");
            });
        });
    });

    describe("pauseCredit and unpauseCredit", function () {
        let creditHash: string;

        async function approveCredit() {
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(borrower.address, toToken(100_000), 1, 1_000, toToken(0), true);
        }

        beforeEach(async function () {
            await loadFixture(approveCredit);
        });

        it("Should allow the EA to pause and unpause a credit", async function () {
            await creditContract.connect(borrower).drawdown(borrower.getAddress(), toToken(1_000));
            await creditContract.connect(eaServiceAccount).pauseCredit(borrower.getAddress());
            let creditRecord = await creditContract.getCreditRecord(creditHash);
            expect(creditRecord.state).to.equal(CreditState.Paused);

            await creditContract.connect(eaServiceAccount).unpauseCredit(borrower.getAddress());
            creditRecord = await creditContract.getCreditRecord(creditHash);
            expect(creditRecord.state).to.equal(CreditState.GoodStanding);
        });

        it("Should do nothing if the credit line is not in the desired states", async function () {
            const oldCreditRecord = await creditContract.getCreditRecord(creditHash);
            await creditContract.connect(eaServiceAccount).pauseCredit(borrower.getAddress());
            let newCreditRecord = await creditContract.getCreditRecord(creditHash);
            expect(newCreditRecord.state).to.equal(oldCreditRecord.state);

            await creditContract.connect(eaServiceAccount).unpauseCredit(borrower.getAddress());
            newCreditRecord = await creditContract.getCreditRecord(creditHash);
            expect(newCreditRecord.state).to.equal(oldCreditRecord.state);
        });
    });

    describe("extendRemainingPeriod", function () {
        let creditHash: string;
        const numOfPeriods = 2;

        async function approveCredit() {
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(borrower.address, toToken(100_000), 1, 1_000, toToken(0), true);
        }

        beforeEach(async function () {
            await loadFixture(approveCredit);
        });

        it("Should allow the EA to extend the remaining periods of a credit line", async function () {
            const oldCreditRecord = await creditContract.getCreditRecord(creditHash);
            const newRemainingPeriods = oldCreditRecord.remainingPeriods + numOfPeriods;
            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(borrower.getAddress(), numOfPeriods),
            )
                .to.emit(creditContract, "RemainingPeriodsExtended")
                .withArgs(
                    creditHash,
                    oldCreditRecord.remainingPeriods,
                    newRemainingPeriods,
                    await eaServiceAccount.getAddress(),
                );
            const newCreditRecord = await creditContract.getCreditRecord(creditHash);
            expect(newCreditRecord.remainingPeriods).to.equal(newRemainingPeriods);
        });

        it("Should disallow non-EAs to extend the remaining period", async function () {
            await expect(
                creditContract
                    .connect(borrower)
                    .extendRemainingPeriod(borrower.getAddress(), numOfPeriods),
            ).to.be.revertedWithCustomError(
                creditContract,
                "evaluationAgentServiceAccountRequired",
            );
        });
    });

    describe("updateLimitAndCommitment", function () {
        let creditHash: string;

        async function approveCredit() {
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(borrower.address, toToken(100_000), 1, 1_000, toToken(0), true);
        }

        beforeEach(async function () {
            await loadFixture(approveCredit);
        });

        it("Should allow the EA to update the credit limit and commitment amount", async function () {
            // TODO(jiatu): fill this in after fixing days passed in period calculation.
        });
    });

    describe("waiveLateFee", function () {
        let creditHash: string;

        async function approveCredit() {
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(borrower.address, toToken(100_000), 1, 1_000, toToken(0), true);
        }

        beforeEach(async function () {
            await loadFixture(approveCredit);
        });

        it("Should allow the EA to partially waive late fees", async function () {
            // TODO(jiatu): fill this in
        });
    });

    describe("Approve Tests", function () {
        it("Should not approve while protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-EA service account to approve", async function () {
            await expect(
                creditContract.approveBorrower(
                    borrower.address,
                    toToken(10_000),
                    1,
                    1217,
                    toToken(10_000),
                    true,
                ),
            ).to.be.revertedWithCustomError(
                creditContract,
                "evaluationAgentServiceAccountRequired",
            );
        });

        it("Should not approve with invalid parameters", async function () {
            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        ethers.constants.AddressZero,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditContract, "zeroAddressProvided");

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(borrower.address, toToken(0), 1, 1217, toToken(10_000), true),
            ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        0,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditContract, "zeroPayPeriods");

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_001),
                        true,
                    ),
            ).to.be.revertedWithCustomError(
                creditContract,
                "committedAmountGreaterThanCreditLimit",
            );

            let poolSettings = await poolConfigContract.getPoolSettings();
            let creditLimit = poolSettings.maxCreditLine.add(1);

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        creditLimit,
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditContract, "greaterThanMaxCreditLine");
        });

        // todo delete this. This test is no longer valid. We should allow a credit to be re-approved
        // with different params before its first drawdown.
        // it("Should not approve while credit line is in wrong state", async function () {
        //     await creditContract
        //         .connect(eaServiceAccount)
        //         .approveBorrower(
        //             borrower.address,
        //             toToken(10_000),
        //             1,
        //             1217,
        //             toToken(10_000),
        //             true,
        //         );

        //     await expect(
        //         creditContract
        //             .connect(eaServiceAccount)
        //             .approveBorrower(
        //                 borrower.address,
        //                 toToken(10_000),
        //                 1,
        //                 1217,
        //                 toToken(10_000),
        //                 true,
        //             ),
        //     ).to.be.revertedWithCustomError(creditContract, "creditLineNotInStateForUpdate");
        // });

        it("Should approve a borrower correctly", async function () {
            const creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );

            let poolSettings = await poolConfigContract.getPoolSettings();

            await expect(
                creditContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        true,
                    ),
            )
                .to.emit(creditContract, "CreditConfigChanged")
                .withArgs(
                    creditHash,
                    toToken(10_000),
                    toToken(10_000),
                    poolSettings.payPeriodInMonths,
                    1,
                    1217,
                    true,
                    false,
                    false,
                    false,
                )
                .to.emit(creditContract, "CreditLineApproved")
                .withArgs(
                    borrower.address,
                    creditHash,
                    toToken(10_000),
                    poolSettings.payPeriodInMonths,
                    1,
                    1217,
                    toToken(10_000),
                    true,
                );

            let creditConfig = await creditContract.getCreditConfig(creditHash);
            checkCreditConfig(
                creditConfig,
                toToken(10_000),
                toToken(10_000),
                poolSettings.payPeriodInMonths,
                1,
                1217,
                true,
                false,
                false,
                false,
            );

            let creditRecord = await creditContract.getCreditRecord(creditHash);
            checkCreditRecord(creditRecord, BN.from(0), 0, BN.from(0), BN.from(0), 0, 1, 2);
        });
    });

    describe("Drawdown Tests", function () {
        it("Should not drawdown with invalid parameters", async function () {
            // borrower == 0
            // borrowAmount == 0
        });

        it("Should not drawdown while credit line is in wrong state", async function () {});

        it("Should not borrow after credit expiration window", async function () {
            // await poolConfigContract.connect(poolOwner).setCreditApprovalExpiration(5);
            // await poolContract
            //     .connect(eaServiceAccount)
            //     .approveCredit(borrower.address, toToken(1_000_000), 30, 12, 1217);
            // await advanceClock(6);
            // await expect(
            //     poolContract.connect(borrower).drawdown(toToken(1_000_000))
            // ).to.revertedWithCustomError(poolContract, "creditExpiredDueToFirstDrawdownTooLate");
        });

        it("Should not borrow after credit expired", async function () {});

        it("Should not borrow while credit limit is exceeded after updateDueInfo", async function () {});

        it("Should not borrow while borrow amount exceeds front loading fees after updateDueInfo", async function () {});

        it.skip("Should allow the borrower to borrow for the first time successfully", async function () {
            const frontLoadingFeeBps = BN.from(100);
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract.connect(poolOwner).setPoolPayPeriod(1);

            const juniorDepositAmount = toToken(300_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            const seniorDepositAmount = toToken(100_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);

            // The borrower needs to make additional first loss cover deposits in order to
            // cover for the new funds made by the lenders.
            await borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        borrower.address,
                    ),
                );

            const yieldInBps = 1217;
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    3,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );

            const creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );

            const borrowAmount = toToken(50_000);
            const netBorrowAmount = borrowAmount
                .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                .div(CONSTANTS.BP_FACTOR);
            const nextTime = await getFutureBlockTime(3);
            await mineNextBlockWithTimestamp(nextTime);

            const [nextDueDate] = getNextDueDate(0, nextTime, 1);
            const yieldDue = calcYield(borrowAmount, yieldInBps, nextDueDate - nextTime);

            const beforeBalance = await mockTokenContract.balanceOf(borrower.address);
            await expect(creditContract.connect(borrower).drawdown(borrower.address, borrowAmount))
                .to.emit(creditContract, "DrawdownMade")
                .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                .to.emit(creditContract, "BillRefreshed")
                .withArgs(creditHash, nextDueDate, yieldDue);
            const afterBalance = await mockTokenContract.balanceOf(borrower.address);
            expect(afterBalance.sub(beforeBalance)).to.equal(netBorrowAmount);

            const creditRecord = await creditContract.getCreditRecord(creditHash);
            checkCreditRecord(
                creditRecord,
                borrowAmount,
                nextDueDate,
                yieldDue,
                yieldDue,
                0,
                2,
                4,
            );
        });

        it.skip("Should allow the borrower to borrow for the second time in the same period successfully", async function () {
            let frontLoadingFeeBps = BN.from(100);
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract.connect(poolOwner).setPoolPayPeriod(3);

            let juniorDepositAmount = toToken(300_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            let seniorDepositAmount = toToken(100_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);

            // The borrower needs to make additional first loss cover deposits in order to
            // cover for the new funds made by the lenders.
            await borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        borrower.address,
                    ),
                );

            const yieldInBps = 1217;
            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    3,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );

            const creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );

            let borrowAmount = toToken(30_000);
            let allBorrowAmount = borrowAmount;
            let netBorrowAmount = borrowAmount
                .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                .div(CONSTANTS.BP_FACTOR);
            let nextTime = await getFutureBlockTime(3);
            await mineNextBlockWithTimestamp(nextTime);

            let [nextDueDate] = getNextDueDate(0, nextTime, 3);
            let yieldDue = calcYield(borrowAmount, yieldInBps, nextDueDate - nextTime);

            let userBeforeBalance = await mockTokenContract.balanceOf(borrower.address);
            let pvBeforeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await expect(creditContract.connect(borrower).drawdown(borrower.address, borrowAmount))
                .to.emit(creditContract, "DrawdownMade")
                .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                .to.emit(creditContract, "BillRefreshed")
                .withArgs(creditHash, nextDueDate, yieldDue);
            let userAfterBalance = await mockTokenContract.balanceOf(borrower.address);
            let pvAfterBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            expect(userAfterBalance.sub(userBeforeBalance)).to.equal(netBorrowAmount);
            expect(pvBeforeBalance.sub(pvAfterBalance)).to.equal(netBorrowAmount);

            let creditRecord = await creditContract.getCreditRecord(creditHash);
            // console.log(`creditRecord: ${creditRecord}`);
            checkCreditRecord(
                creditRecord,
                borrowAmount,
                nextDueDate,
                yieldDue,
                yieldDue,
                0,
                2,
                4,
            );

            // move forward 10 days
            nextTime = nextTime + 3600 * 24 * 10;
            await mineNextBlockWithTimestamp(nextTime);

            borrowAmount = toToken(20_000);
            allBorrowAmount = allBorrowAmount.add(borrowAmount);
            netBorrowAmount = borrowAmount
                .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                .div(CONSTANTS.BP_FACTOR);

            userBeforeBalance = await mockTokenContract.balanceOf(borrower.address);
            pvBeforeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await expect(creditContract.connect(borrower).drawdown(borrower.address, borrowAmount))
                .to.emit(creditContract, "DrawdownMade")
                .withArgs(borrower.address, borrowAmount, netBorrowAmount);
            // .to.emit(creditContract, "BillRefreshed");
            // .withArgs(creditHash, nextDueDate, yieldDue);
            userAfterBalance = await mockTokenContract.balanceOf(borrower.address);
            pvAfterBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            expect(userAfterBalance.sub(userBeforeBalance)).to.equal(netBorrowAmount);
            expect(pvBeforeBalance.sub(pvAfterBalance)).to.equal(netBorrowAmount);

            yieldDue = yieldDue.add(calcYield(borrowAmount, yieldInBps, nextDueDate - nextTime));
            creditRecord = await creditContract.getCreditRecord(creditHash);
            // console.log(`creditRecord: ${creditRecord}`);
            checkCreditRecord(
                creditRecord,
                allBorrowAmount,
                nextDueDate,
                yieldDue,
                yieldDue,
                0,
                2,
                4,
            );
        });

        it("Should borrow second time after next due date and before grace late date", async function () {});
    });

    describe("MakePayment Tests", function () {
        const yieldInBps = 1217;
        const frontLoadingFeeBps = 100;
        const periodDuration = 2;

        let borrowAmount: BN, creditHash: string;

        async function prepareForMakePayment() {
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract.connect(poolOwner).setPoolPayPeriod(periodDuration);

            let juniorDepositAmount = toToken(300_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            let seniorDepositAmount = toToken(100_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);

            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    3,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );
            await borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        borrower.address,
                    ),
                );

            borrowAmount = toToken(50_000);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );
        }

        beforeEach(async function () {
            await loadFixture(prepareForMakePayment);
        });

        it("Should not approve while protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditContract.makePayment(borrower.address, toToken(1)),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditContract.makePayment(borrower.address, toToken(1)),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-borrower or non-PDS service account to makePayment", async function () {});

        it("Should not makePayment with invalid parameters", async function () {});

        it("Should make payment partially payment successfully in GoodStanding state and before due date", async function () {});

        it("Should make payment partially payment successfully in GoodStanding state and between due date and grace late period", async function () {});

        it("Should make payment fully successfully in GoodStanding state and before due date", async function () {});

        it("Should make payment fully successfully in GoodStanding state and between due date and grace late period", async function () {});

        it("Should pay off successfully in GoodStanding state and before due date", async function () {});

        it("Should pay off successfully in GoodStanding state and between due date and grace late period", async function () {});
    });

    describe("RefreshCredit Tests", function () {
        const yieldInBps = 1217;
        const frontLoadingFeeBps = 100;
        const periodDuration = 2;
        let borrowAmount: BN, creditHash: string, borrowAmount2: BN, creditHash2: string;

        async function prepareForRefreshCredit() {
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat: 0,
                frontLoadingFeeBps: frontLoadingFeeBps,
            });

            await poolConfigContract.connect(poolOwner).setPoolPayPeriod(periodDuration);

            await poolConfigContract
                .connect(poolOwner)
                .setPoolDefaultGracePeriod(periodDuration * 3);

            let juniorDepositAmount = toToken(300_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            let seniorDepositAmount = toToken(100_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);

            // The borrower needs to make additional first loss cover deposits in order to
            // cover for the new funds made by the lenders.
            await borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        borrower.address,
                    ),
                );

            await creditContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    5,
                    yieldInBps,
                    toToken(100_000),
                    true,
                );

            borrowAmount = toToken(10_000);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            creditHash = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["address", "address"],
                    [creditContract.address, borrower.address],
                ),
            );
        }

        beforeEach(async function () {
            await loadFixture(prepareForRefreshCredit);
        });

        it("Should not create new due info before due date", async function () {
            let creditRecord = await creditContract.getCreditRecord(creditHash);

            // move forward 10 days
            let nextTime = await getFutureBlockTime(3600 * 24 * 10);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.getCreditRecord(creditHash);
            checkTwoCreditRecords(preCreditRecord, creditRecord);
        });

        it("Should not create new due info after due date and before grace late date", async function () {
            let creditRecord = await creditContract.getCreditRecord(creditHash);

            // move forward after due date and before grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                creditRecord.nextDueDate.toNumber() +
                3600 * 24 * (poolSettings.latePaymentGracePeriodInDays - 1);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.getCreditRecord(creditHash);
            checkTwoCreditRecords(preCreditRecord, creditRecord);
        });

        it.skip("Should create new due info after grace late date", async function () {
            let creditRecord = await creditContract.getCreditRecord(creditHash);

            // move forward after grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                creditRecord.nextDueDate.toNumber() +
                3600 * 24 * (poolSettings.latePaymentGracePeriodInDays + 1);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.getCreditRecord(creditHash);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            let creditRecordSettings = await getCreditRecordSettings();
            let creditConfig = await creditContract.getCreditConfig(creditHash);
            let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                1,
                nextTime,
                creditRecordSettings,
            );
            printCreditRecord(`newCreditRecord`, newCreditRecord);
            checkTwoCreditRecords(creditRecord, newCreditRecord);
        });

        it.skip("Should create new due info after multiple periods", async function () {
            let creditRecord = await creditContract.getCreditRecord(creditHash);

            // move forward after grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                getNextDueDate(
                    creditRecord.nextDueDate.toNumber(),
                    creditRecord.nextDueDate.toNumber(),
                    periodDuration,
                )[0] +
                60 * 10;
            await mineNextBlockWithTimestamp(nextTime);
            // console.log(`nextTime: ${nextTime}`);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.getCreditRecord(creditHash);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            let creditRecordSettings = await getCreditRecordSettings();
            let creditConfig = await creditContract.getCreditConfig(creditHash);
            let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                2,
                nextTime,
                creditRecordSettings,
            );
            printCreditRecord(`newCreditRecord`, newCreditRecord);
            checkTwoCreditRecords(creditRecord, newCreditRecord);
        });

        it.skip("Should create new due info while credit state is delayed", async function () {
            let creditRecord = await creditContract.getCreditRecord(creditHash);

            // move forward after grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                creditRecord.nextDueDate.toNumber() +
                3600 * 24 * (poolSettings.latePaymentGracePeriodInDays + 2);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.getCreditRecord(creditHash);

            let creditRecordSettings = await getCreditRecordSettings();
            let creditConfig = await creditContract.getCreditConfig(creditHash);
            let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                1,
                nextTime,
                creditRecordSettings,
            );
            checkTwoCreditRecords(creditRecord, newCreditRecord);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            let defaultDate = calcDefaultDate(
                preCreditRecord,
                poolSettings.defaultGracePeriodInMonths,
            );
            let lossStartDate = preCreditRecord.nextDueDate.toNumber();
            let lossStartPrincipal = getPrincipal(preCreditRecord);

            nextTime =
                getNextDueDate(
                    preCreditRecord.nextDueDate.toNumber(),
                    preCreditRecord.nextDueDate.toNumber(),
                    2 * periodDuration,
                )[0] +
                60 * 10;
            await mineNextBlockWithTimestamp(nextTime);

            preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.getCreditRecord(creditHash);

            // console.log(`nextTime: ${nextTime}`);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                2,
                nextTime,
                creditRecordSettings,
            );
            checkTwoCreditRecords(creditRecord, newCreditRecord);
        });

        it.skip("Should become defaulted after default grace periods", async function () {
            //* todo add CreditLoss expects

            let creditRecord = await creditContract.getCreditRecord(creditHash);

            // move forward after grace late date
            let poolSettings = await poolConfigContract.getPoolSettings();
            let nextTime =
                creditRecord.nextDueDate.toNumber() +
                3600 * 24 * (poolSettings.latePaymentGracePeriodInDays + 1);
            await mineNextBlockWithTimestamp(nextTime);

            let preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.getCreditRecord(creditHash);

            let creditRecordSettings = await getCreditRecordSettings();
            let creditConfig = await creditContract.getCreditConfig(creditHash);
            let [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                1,
                nextTime,
                creditRecordSettings,
            );
            // printCreditRecord(`preCreditRecord`, preCreditRecord);
            // printCreditRecord(`creditRecord`, creditRecord);
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            let defaultDate = calcDefaultDate(
                preCreditRecord,
                poolSettings.defaultGracePeriodInMonths,
            );
            let lossStartDate = preCreditRecord.nextDueDate.toNumber();
            let lossStartPrincipal = getPrincipal(preCreditRecord);

            // console.log(`creditLoss: ${creditLoss}`);

            let accruedLoss = getPrincipal(creditRecord)
                .sub(lossStartPrincipal)
                .add(
                    calcYield(
                        getPrincipal(creditRecord),
                        yieldInBps,
                        nextTime -
                            getStartDateOfPeriod(
                                periodDuration,
                                creditRecord.nextDueDate.toNumber(),
                            ),
                    ),
                );
            // console.log(`accruedLoss: ${accruedLoss}, lossRate: ${lossRate}`);

            nextTime =
                getNextDueDate(
                    preCreditRecord.nextDueDate.toNumber(),
                    preCreditRecord.nextDueDate.toNumber(),
                    3 * periodDuration,
                )[0] +
                60 * 5;
            await mineNextBlockWithTimestamp(nextTime);

            preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.getCreditRecord(creditHash);

            // console.log(`nextTime: ${nextTime}`);
            printCreditRecord(`preCreditRecord`, preCreditRecord);
            printCreditRecord(`creditRecord`, creditRecord);

            [newCreditRecord, principalDiff, missProfit] = calcLateCreditRecord(
                preCreditRecord,
                creditConfig,
                3,
                nextTime,
                creditRecordSettings,
            );
            newCreditRecord.state = 5;
            checkTwoCreditRecords(creditRecord, newCreditRecord);

            // credit doesn't change after default

            preCreditRecord = creditRecord;
            await creditContract.refreshCredit(borrower.address);
            creditRecord = await creditContract.getCreditRecord(creditHash);
            checkTwoCreditRecords(creditRecord, newCreditRecord);
        });

        it("Should refresh credit correctly with multiple credits, while setting late fee, membership fee and minPrincipalRateInBps", async function () {
            //* todo fix this test

            let creditRecord = await creditContract.getCreditRecord(creditHash);

            // printCreditRecord(`creditRecord`, creditRecord);
            // let profitRate = calcProfitRateWithCR(creditRecord, yieldInBps);
            // let accruedProfit = borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR);
            // let block = await getLatestBlock();
            // // console.log(`accruedProfit: ${accruedProfit}`);
            // let pnlTracker = await creditPnlManagerContract.getPnL();
            // // console.log(`pnlTracker: ${pnlTracker}`);
            // checkPnLTracker(
            //     pnlTracker,
            //     profitRate,
            //     block.timestamp,
            //     accruedProfit,
            //     BN.from(0),
            //     BN.from(0),
            // );
            // let preTime = block.timestamp;
            // let lateFeeBps = 200;
            // let membershipFee = toToken(100);
            // let minPrincipalRateInBps = 1000;
            // await poolConfigContract.connect(poolOwner).setFeeStructure({
            //     yieldInBps: yieldInBps,
            //     minPrincipalRateInBps: minPrincipalRateInBps,
            //     lateFeeFlat: BN.from(0),
            //     lateFeeBps: lateFeeBps,
            //     membershipFee: membershipFee,
            // });
            // await creditContract
            //     .connect(eaServiceAccount)
            //     .approveBorrower(
            //         borrower2.address,
            //         toToken(100_000),
            //         5,
            //         yieldInBps,
            //         toToken(100_000),
            //         true,
            //     );
            // // Make sure borrower2 has enough first loss cover.
            // await borrowerFirstLossCoverContract
            //     .connect(borrower2)
            //     .depositCover(
            //         await getMinFirstLossCoverRequirement(
            //             borrowerFirstLossCoverContract,
            //             poolConfigContract,
            //             poolContract,
            //             borrower2.address,
            //         ),
            //     );
            // // move forward 30 days for borrower2 drawdown
            // block = await getLatestBlock();
            // let nextTime = timestampToMoment(block.timestamp).add(1, "months").unix();
            // // console.log(`nextTime: ${nextTime}`);
            // await mineNextBlockWithTimestamp(nextTime);
            // borrowAmount2 = toToken(15_000);
            // await creditContract.connect(borrower2).drawdown(borrower2.address, borrowAmount2);
            // creditHash2 = ethers.utils.keccak256(
            //     ethers.utils.defaultAbiCoder.encode(
            //         ["address", "address"],
            //         [creditContract.address, borrower2.address],
            //     ),
            // );
            // accruedProfit = accruedProfit.add(
            //     BN.from(nextTime - preTime)
            //         .mul(profitRate)
            //         .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            // );
            // let accruedProfit2 = borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR);
            // let creditRecord2 = await creditContract.getCreditRecord(creditHash2);
            // let profitRate2 = calcProfitRateWithCR(creditRecord2, yieldInBps);
            // pnlTracker = await creditPnlManagerContract.getPnL();
            // // console.log(`pnlTracker: ${pnlTracker}`);
            // checkPnLTracker(
            //     pnlTracker,
            //     profitRate.add(profitRate2),
            //     nextTime,
            //     accruedProfit.add(accruedProfit2),
            //     BN.from(0),
            //     BN.from(0),
            //     2,
            // );
            // preTime = nextTime;
            // // refresh browser credit and its state becomes delayed
            // let poolSettings = await poolConfigContract.getPoolSettings();
            // let creditRecordSettings = await getCreditRecordSettings();
            // let creditConfig = await creditContract.getCreditConfig(creditHash);
            // creditRecord = await creditContract.getCreditRecord(creditHash);
            // nextTime =
            //     creditRecord.nextDueDate.toNumber() +
            //     3600 * 24 * poolSettings.latePaymentGracePeriodInDays +
            //     60 * 10;
            // // printCreditRecord(`creditRecord`, creditRecord);
            // // console.log(`nextTime: ${nextTime}`);
            // await mineNextBlockWithTimestamp(nextTime);
            // let preCreditRecord = creditRecord;
            // await creditContract.refreshCredit(borrower.address);
            // creditRecord = await creditContract.getCreditRecord(creditHash);
            // let [newCreditRecord, ,] = calcLateCreditRecord(
            //     preCreditRecord,
            //     creditConfig,
            //     1,
            //     nextTime,
            //     creditRecordSettings,
            // );
            // // printCreditRecord(`newCreditRecord`, newCreditRecord);
            // checkTwoCreditRecords(creditRecord, newCreditRecord);
            // profitRate = calcProfitRateWithCR(creditRecord, yieldInBps);
            // let defaultDate = calcDefaultDate(
            //     preCreditRecord,
            //     poolSettings.defaultGracePeriodInMonths,
            // );
            // accruedProfit = preCreditRecord.yieldDue
            //     .add(
            //         calcYield(
            //             getPrincipal(creditRecord),
            //             yieldInBps,
            //             nextTime - preCreditRecord.nextDueDate.toNumber(),
            //         ),
            //     )
            //     .add(borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR));
            // accruedProfit2 = BN.from(
            //     borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            // ).add(calcYield(getPrincipal(creditRecord2), yieldInBps, nextTime - preTime));
            // let accruedLoss = getPrincipal(creditRecord)
            //     .sub(getPrincipal(preCreditRecord))
            //     .add(
            //         calcYield(
            //             getPrincipal(creditRecord),
            //             yieldInBps,
            //             nextTime -
            //                 getStartDateOfPeriod(
            //                     CONSTANTS.CALENDAR_UNIT_MONTH,
            //                     periodDuration,
            //                     creditRecord.nextDueDate.toNumber(),
            //                 ),
            //         ),
            //     );
            // pnlTracker = await creditPnlManagerContract.getPnL();
            // // console.log(`pnlTracker: ${pnlTracker}`);
            // checkPnLTracker(
            //     pnlTracker,
            //     profitRate.add(profitRate2),
            //     nextTime,
            //     accruedProfit.add(accruedProfit2),
            //     BN.from(0),
            //     BN.from(0),
            //     2,
            // );
            // let creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            // // console.log(`creditLoss: ${creditLoss}`);
            // checkCreditLoss(creditLoss, accruedLoss, BN.from(0), 1);
            // // refresh browser2 credit and its state becomes delayed
            // creditRecord2 = await creditContract.getCreditRecord(creditHash2);
            // preTime = nextTime;
            // nextTime =
            //     creditRecord2.nextDueDate.toNumber() +
            //     3600 * 24 * poolSettings.latePaymentGracePeriodInDays +
            //     60 * 5;
            // printCreditRecord(`creditRecord2`, creditRecord2);
            // console.log(`nextTime: ${nextTime}`);
            // await mineNextBlockWithTimestamp(nextTime);
            // let preCreditRecord2 = creditRecord2;
            // await creditContract.refreshCredit(borrower2.address);
            // creditRecord2 = await creditContract.getCreditRecord(creditHash2);
            // printCreditRecord(`creditRecord2`, creditRecord2);
            // let [newCreditRecord2, ,] = calcLateCreditRecord(
            //     preCreditRecord2,
            //     creditConfig,
            //     1,
            //     nextTime,
            //     creditRecordSettings,
            // );
            // // printCreditRecord(`newCreditRecord`, newCreditRecord);
            // checkTwoCreditRecords(creditRecord2, newCreditRecord2);
            // profitRate2 = calcProfitRateWithCR(creditRecord2, yieldInBps);
            // let defaultDate2 = calcDefaultDate(
            //     preCreditRecord2,
            //     poolSettings.defaultGracePeriodInMonths,
            // );
            // accruedProfit2 = BN.from(
            //     borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            // )
            //     .add(getPrincipal(creditRecord2).sub(borrowAmount2))
            //     .add(
            //         calcYield(
            //             getPrincipal(creditRecord2),
            //             yieldInBps,
            //             nextTime - preCreditRecord2.nextDueDate.toNumber(),
            //         ),
            //     );
            // accruedProfit = accruedProfit.add(
            //     calcYield(getPrincipal(creditRecord), yieldInBps, nextTime - preTime),
            // );
            // let accruedLoss2 = getPrincipal(creditRecord2)
            //     .sub(getPrincipal(preCreditRecord2))
            //     .add(
            //         calcYield(
            //             getPrincipal(creditRecord2),
            //             yieldInBps,
            //             nextTime -
            //                 getStartDateOfPeriod(
            //                     CONSTANTS.CALENDAR_UNIT_MONTH,
            //                     periodDuration,
            //                     creditRecord2.nextDueDate.toNumber(),
            //                 ),
            //         ),
            //     );
            // // console.log(
            // //     `profitRate.add(profitRate2): ${profitRate.add(
            // //         profitRate2,
            // //     )}, lossRate.add(lossRate2): ${lossRate.add(
            // //         lossRate2,
            // //     )}, accruedProfit.add(accruedProfit2): ${accruedProfit.add(
            // //         accruedProfit2,
            // //     )}, accruedLoss.add(accruedLoss2): ${accruedLoss.add(accruedLoss2)}`,
            // // );
            // pnlTracker = await creditPnlManagerContract.getPnL();
            // // console.log(`pnlTracker: ${pnlTracker}`);
            // checkPnLTracker(
            //     pnlTracker,
            //     profitRate.add(profitRate2),
            //     nextTime,
            //     accruedProfit.add(accruedProfit2),
            //     accruedLoss.add(accruedLoss2),
            //     BN.from(0),
            //     2,
            // );
            // let creditLoss2 = await creditPnlManagerContract.getCreditLoss(creditHash2);
            // // console.log(`creditLoss: ${creditLoss}`);
            // checkCreditLoss(creditLoss2, accruedLoss2, BN.from(0), 1);
            // // move forward, refresh browser credit and its state becomes defaulted
            // preTime = nextTime;
            // nextTime =
            //     getNextMonth(
            //         preCreditRecord.nextDueDate.toNumber(),
            //         preCreditRecord.nextDueDate.toNumber(),
            //         3 * periodDuration,
            //     )[0] +
            //     60 * 5;
            // await mineNextBlockWithTimestamp(nextTime);
            // preCreditRecord = creditRecord;
            // await creditContract.refreshCredit(borrower.address);
            // creditRecord = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord(`creditRecord`, creditRecord);
            // [newCreditRecord, ,] = calcLateCreditRecord(
            //     preCreditRecord,
            //     creditConfig,
            //     3,
            //     nextTime,
            //     creditRecordSettings,
            // );
            // newCreditRecord.state = 6;
            // checkTwoCreditRecords(creditRecord, newCreditRecord);
            // accruedProfit = BN.from(
            //     borrowAmount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            // ).add(getPrincipal(creditRecord).sub(borrowAmount));
            // accruedProfit2 = accruedProfit2.add(
            //     profitRate2.mul(nextTime - preTime).div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
            // );
            // accruedLoss = getPrincipal(creditRecord);
            // // console.log(
            // //     `profitRate.add(profitRate2): ${profitRate2}, lossRate.add(lossRate2): ${lossRate2}, accruedProfit.add(accruedProfit2): ${accruedProfit.add(
            // //         accruedProfit2,
            // //     )}, accruedLoss.add(accruedLoss2): ${accruedLoss.add(accruedLoss2)}`,
            // // );
            // pnlTracker = await creditPnlManagerContract.getPnL();
            // // console.log(`pnlTracker: ${pnlTracker}`);
            // checkPnLTracker(
            //     pnlTracker,
            //     profitRate2,
            //     nextTime,
            //     accruedProfit.add(accruedProfit2),
            //     accruedLoss.add(accruedLoss2),
            //     BN.from(0),
            //     4,
            // );
            // creditLoss = await creditPnlManagerContract.getCreditLoss(creditHash);
            // checkCreditLoss(creditLoss, accruedLoss, BN.from(0), 3);
            // // move forward, refresh browser2 credit and its state becomes defaulted
            // nextTime =
            //     getNextMonth(
            //         preCreditRecord2.nextDueDate.toNumber(),
            //         preCreditRecord2.nextDueDate.toNumber(),
            //         3 * periodDuration,
            //     )[0] +
            //     60 * 5;
            // await mineNextBlockWithTimestamp(nextTime);
            // preCreditRecord2 = creditRecord2;
            // await creditContract.refreshCredit(borrower2.address);
            // creditRecord2 = await creditContract.getCreditRecord(creditHash2);
            // [newCreditRecord2, ,] = calcLateCreditRecord(
            //     preCreditRecord2,
            //     creditConfig,
            //     3,
            //     nextTime,
            //     creditRecordSettings,
            // );
            // newCreditRecord2.state = 6;
            // checkTwoCreditRecords(creditRecord2, newCreditRecord2);
            // accruedProfit2 = BN.from(
            //     borrowAmount2.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            // ).add(getPrincipal(creditRecord2).sub(borrowAmount2));
            // accruedLoss2 = getPrincipal(creditRecord2);
            // pnlTracker = await creditPnlManagerContract.getPnL();
            // checkPnLTracker(
            //     pnlTracker,
            //     BN.from(0),
            //     nextTime,
            //     accruedProfit.add(accruedProfit2),
            //     accruedLoss.add(accruedLoss2),
            //     BN.from(0),
            //     5,
            // );
            // creditLoss2 = await creditPnlManagerContract.getCreditLoss(creditHash2);
            // checkCreditLoss(creditLoss2, accruedLoss2, BN.from(0), 3);
        });
    });

    describe("Delayed Tests", function () {
        it("Should refresh credit and credit becomes Delayed state", async function () {});

        it("Should not borrower in Delayed state", async function () {});

        it("Should make partially payment successfully in Delayed state", async function () {});

        it("Should pay total due successfully and credit becomes GoodStanding state", async function () {});

        it("Should pay off successfully in Delayed state", async function () {});
    });

    describe("Defaulted Tests", function () {
        it("Should refresh credit and credit becomes Defaulted state", async function () {});

        it("Should not borrower in Defaulted state", async function () {});

        it("Should make partially payment successfully in Defaulted state", async function () {});

        it("Should pay off successfully in Defaulted state", async function () {});
    });
});
