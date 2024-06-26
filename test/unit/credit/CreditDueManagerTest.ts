import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import moment from "moment";
import {
    Calendar,
    CreditDueManager,
    EpochManager,
    FirstLossCover,
    HumaConfig,
    MockPoolCredit,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import {
    CreditConfigStruct,
    CreditRecordStruct,
    DueDetailStruct,
} from "../../../typechain-types/contracts/credit/CreditDueManager";
import {
    CreditState,
    PayPeriodDuration,
    calcLateFee,
    calcPrincipalDue,
    calcYieldDue,
    checkCreditRecordsMatch,
    checkDueDetailsMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    getPrincipal,
} from "../../BaseTest";
import {
    evmRevert,
    evmSnapshot,
    getFutureBlockTime,
    maxBigNumber,
    toToken,
} from "../../TestUtils";
import { CONSTANTS } from "../../constants";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress,
    protocolTreasury: SignerWithAddress,
    lender: SignerWithAddress;

let humaConfigContract: HumaConfig, mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    adminFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager;

describe("CreditDueManager Tests", function () {
    let sId: unknown;

    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            protocolTreasury,
            sentinelServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            lender,
        ] = await ethers.getSigners();
        sId = await evmSnapshot();
    });

    after(async function () {
        if (sId) {
            await evmRevert(sId);
        }
    });

    async function prepare() {
        [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            protocolTreasury,
            sentinelServiceAccount,
            poolOwner,
        );

        [
            poolConfigContract,
            poolFeeManagerContract,
            poolSafeContract,
            calendarContract,
            borrowerFirstLossCoverContract,
            adminFirstLossCoverContract,
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
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            "CreditLineManager",
            evaluationAgent,
            protocolTreasury,
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("calcFrontLoadingFee", function () {
        let amount: BN;

        before(function () {
            amount = toToken(1_000);
        });

        it("Should return the correct front loading fees if there is a variable component", async function () {
            const frontLoadingFeeFlat = toToken(5),
                frontLoadingFeeBps = 500;
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat,
                frontLoadingFeeBps,
            });
            const expectedFrontLoadingFees = frontLoadingFeeFlat.add(
                amount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            );
            expect(await creditDueManagerContract.calcFrontLoadingFee(amount)).to.equal(
                expectedFrontLoadingFees,
            );
        });

        it("Should return the correct front loading fees if there is no variable component", async function () {
            const frontLoadingFeeFlat = toToken(5),
                frontLoadingFeeBps = 0;
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat,
                frontLoadingFeeBps,
            });
            expect(await creditDueManagerContract.calcFrontLoadingFee(amount)).to.equal(
                frontLoadingFeeFlat,
            );
        });
    });

    describe("distBorrowingAmount", function () {
        let frontLoadingFeeFlat: BN;

        async function setFrontLoadingFee() {
            frontLoadingFeeFlat = toToken(10);
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat,
                frontLoadingFeeBps: 0,
            });
        }

        beforeEach(async function () {
            await loadFixture(setFrontLoadingFee);
        });

        it("Should return the correct amount to the borrower and the platform fees", async function () {
            const borrowAmount = toToken(100);
            const amounts = await creditDueManagerContract.distBorrowingAmount(borrowAmount);
            expect(amounts[0]).to.equal(borrowAmount.sub(frontLoadingFeeFlat));
            expect(amounts[1]).to.equal(frontLoadingFeeFlat);
        });

        it("Should revert if the borrow amount is less than the platform fees", async function () {
            const borrowAmount = toToken(9);
            await expect(
                creditDueManagerContract.distBorrowingAmount(borrowAmount),
            ).to.be.revertedWithCustomError(
                creditDueManagerContract,
                "BorrowAmountLessThanPlatformFees",
            );
        });
    });

    describe("getNextBillRefreshDate", function () {
        let nextDueDate: moment.Moment;
        const latePaymentGracePeriodInDays = 5;

        async function prepare() {
            let settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{ latePaymentGracePeriodInDays: latePaymentGracePeriodInDays },
            });
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        describe("If the bill is currently in good standing and has unpaid next due", function () {
            async function setNextBlockTime() {
                nextDueDate = moment
                    .utc((await getFutureBlockTime(2)) * 1000)
                    .clone()
                    .add(2, "days");
            }

            beforeEach(async function () {
                await loadFixture(setNextBlockTime);
            });

            it("Should return the late payment deadline", async function () {
                const creditRecord = {
                    unbilledPrincipal: 0,
                    nextDueDate: nextDueDate.unix(),
                    nextDue: toToken(1_000),
                    yieldDue: 0,
                    totalPastDue: 0,
                    missedPeriods: 0,
                    remainingPeriods: 2,
                    state: CreditState.GoodStanding,
                };
                expect(
                    await creditDueManagerContract.getNextBillRefreshDate(creditRecord),
                ).to.equal(nextDueDate.add(latePaymentGracePeriodInDays, "days").unix());
            });
        });

        describe("If the bill is currently in good standing and has no unpaid next due", function () {
            async function setNextBlockTime() {
                nextDueDate = moment.utc((await getFutureBlockTime(2)) * 1000);
            }

            beforeEach(async function () {
                await loadFixture(setNextBlockTime);
            });

            it("Should return the due date of the current bill", async function () {
                const creditRecord = {
                    unbilledPrincipal: 0,
                    nextDueDate: nextDueDate.unix(),
                    nextDue: 0,
                    yieldDue: 0,
                    totalPastDue: 0,
                    missedPeriods: 0,
                    remainingPeriods: 2,
                    state: CreditState.GoodStanding,
                };
                expect(
                    await creditDueManagerContract.getNextBillRefreshDate(creditRecord),
                ).to.equal(nextDueDate.unix());
            });
        });

        describe("If the bill is already late", function () {
            async function setNextBlockTime() {
                nextDueDate = moment.utc((await getFutureBlockTime(2)) * 1000);
            }

            beforeEach(async function () {
                await loadFixture(setNextBlockTime);
            });

            it("Should return the due date of the current bill", async function () {
                const creditRecord = {
                    unbilledPrincipal: 0,
                    nextDueDate: nextDueDate.unix(),
                    nextDue: toToken(1_000),
                    yieldDue: toToken(400),
                    totalPastDue: toToken(2_000),
                    missedPeriods: 1,
                    remainingPeriods: 2,
                    state: CreditState.Delayed,
                };
                expect(
                    await creditDueManagerContract.getNextBillRefreshDate(creditRecord),
                ).to.equal(nextDueDate.unix());
            });
        });
    });

    describe("getDueInfo", function () {
        function getInputParams(
            creditConfigOverrides: Partial<CreditConfigStruct> = {},
            creditRecordOverrides: Partial<CreditRecordStruct> = {},
            dueDetailOverrides: Partial<DueDetailStruct> = {},
        ): [CreditConfigStruct, CreditRecordStruct, DueDetailStruct] {
            const cc = {
                ...{
                    creditLimit: toToken(5_000),
                    committedAmount: toToken(5_000),
                    periodDuration: PayPeriodDuration.Monthly,
                    numOfPeriods: 3,
                    yieldInBps: 1000,
                    advanceRateInBps: 8000,
                    revolving: true,
                    receivableAutoApproval: true,
                },
                ...creditConfigOverrides,
            };
            const cr = {
                ...{
                    unbilledPrincipal: toToken(5_000),
                    nextDueDate: moment.utc().unix(),
                    nextDue: toToken(1_000),
                    yieldDue: toToken(400),
                    totalPastDue: 0,
                    missedPeriods: 0,
                    remainingPeriods: 3,
                    state: CreditState.GoodStanding,
                },
                ...creditRecordOverrides,
            };
            const dd = {
                ...{
                    lateFeeUpdatedDate: moment.utc().unix(),
                    lateFee: 0,
                    yieldPastDue: 0,
                    principalPastDue: 0,
                    committed: toToken(5_000),
                    accrued: toToken(4_000),
                    paid: 0,
                },
                ...dueDetailOverrides,
            };

            return [cc, cr, dd];
        }

        describe("If the bill is deleted", function () {
            it("Should return the CreditRecord and DueDetail as is", async function () {
                const timestamp = await getFutureBlockTime(2);

                const [cc, cr, dd] = getInputParams({}, { state: CreditState.Deleted });
                const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                    cr,
                    cc,
                    dd,
                    timestamp,
                );
                checkCreditRecordsMatch(newCR, cr);
                checkDueDetailsMatch(newDD, dd);
            });
        });

        describe("If the bill is defaulted", function () {
            it("Should return the CreditRecord and DueDetail as is", async function () {
                const timestamp = await getFutureBlockTime(2);

                const [cc, cr, dd] = getInputParams({}, { state: CreditState.Defaulted });
                const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                    cr,
                    cc,
                    dd,
                    timestamp,
                );
                checkCreditRecordsMatch(newCR, cr);
                checkDueDetailsMatch(newDD, dd);
            });
        });

        describe("If the bill is approved but has not yet reached the designated start date", function () {
            it("Should return the CreditRecord and DueDetail as is", async function () {
                const timestamp = await getFutureBlockTime(2);

                const [cc, cr, dd] = getInputParams(
                    {},
                    {
                        state: CreditState.Approved,
                        nextDueDate: timestamp + CONSTANTS.SECONDS_IN_A_DAY,
                    },
                );
                const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                    cr,
                    cc,
                    dd,
                    timestamp,
                );
                checkCreditRecordsMatch(newCR, cr);
                checkDueDetailsMatch(newDD, dd);
            });
        });

        describe("If the current block timestamp is within the current billing cycle", function () {
            describe("If the bill is not late", function () {
                it("Should return the CreditRecord and DueDetail as is", async function () {
                    const timestamp = await getFutureBlockTime(2);

                    const [cc, cr, dd] = getInputParams({}, { nextDueDate: timestamp + 1 });
                    const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                        cr,
                        cc,
                        dd,
                        timestamp,
                    );
                    checkCreditRecordsMatch(newCR, cr);
                    checkDueDetailsMatch(newDD, dd);
                });
            });

            describe("If the bill is late", function () {
                it("Should return updated CreditRecord and DueDetail with refreshed late fees", async function () {
                    const timestamp = await getFutureBlockTime(2);

                    const lateFeeBps = 500;
                    await poolConfigContract.connect(poolOwner).setFeeStructure({
                        yieldInBps: 1000,
                        minPrincipalRateInBps: 10,
                        lateFeeBps,
                    });

                    const [cc, cr, dd] = getInputParams(
                        {},
                        {
                            nextDueDate: timestamp + 1,
                            missedPeriods: 1,
                            state: CreditState.Delayed,
                        },
                    );
                    const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                        cr,
                        cc,
                        dd,
                        timestamp,
                    );
                    const [lateFeeUpdatedDate, lateFee] = await calcLateFee(
                        poolConfigContract,
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        timestamp,
                    );
                    const expectedNewCR = {
                        ...cr,
                        ...{
                            totalPastDue: BN.from(cr.totalPastDue).add(lateFee),
                        },
                    };
                    const expectedNewDD = {
                        ...dd,
                        ...{ lateFeeUpdatedDate: lateFeeUpdatedDate, lateFee: lateFee },
                    };
                    checkCreditRecordsMatch(newCR, expectedNewCR);
                    checkDueDetailsMatch(newDD, expectedNewDD);
                });
            });
        });

        describe("If the current block timestamp has surpassed the due date of the last known billing cycle", function () {
            describe("If the bill is in good standing and the current block timestamp is still within the late payment grace period", function () {
                it("Should return the CreditRecord and DueDetail as is", async function () {
                    const timestamp = await getFutureBlockTime(2);

                    const latePaymentGracePeriodInDays = 5;
                    let settings = await poolConfigContract.getPoolSettings();
                    await poolConfigContract.connect(poolOwner).setPoolSettings({
                        ...settings,
                        ...{ latePaymentGracePeriodInDays: latePaymentGracePeriodInDays },
                    });

                    // Set the due date so that the current block timestamp falls within the late payment
                    // grace period.
                    const nextDueDate = moment(timestamp * 1000)
                        .utc()
                        .subtract(latePaymentGracePeriodInDays, "days")
                        .add(1, "second")
                        .unix();
                    const [cc, cr, dd] = getInputParams(
                        {},
                        { nextDueDate: nextDueDate, state: CreditState.GoodStanding },
                    );
                    const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                        cr,
                        cc,
                        dd,
                        timestamp,
                    );
                    checkCreditRecordsMatch(newCR, cr);
                    checkDueDetailsMatch(newDD, dd);
                });
            });

            describe("If this is the first drawdown", function () {
                describe("If the principal rate is 0", function () {
                    it("Should return the correct due date and amounts", async function () {
                        const timestamp = await getFutureBlockTime(1);
                        const drawdownDate = (
                            await calendarContract.getStartDateOfNextPeriod(
                                PayPeriodDuration.Monthly,
                                timestamp,
                            )
                        ).add(14 * CONSTANTS.SECONDS_IN_A_DAY);

                        const lateFeeBps = 500;
                        await poolConfigContract.connect(poolOwner).setFeeStructure({
                            yieldInBps: 1000,
                            minPrincipalRateInBps: 0,
                            lateFeeBps,
                        });
                        const [cc, cr, dd] = getInputParams(
                            {},
                            {
                                nextDue: 0,
                                yieldDue: 0,
                                nextDueDate: 0,
                                state: CreditState.Approved,
                            },
                        );

                        const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                            cr,
                            cc,
                            dd,
                            drawdownDate,
                        );
                        const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                            cc.periodDuration,
                            drawdownDate,
                        );
                        const principal = getPrincipal(cr, dd);
                        const [accruedYield, committedYield] = calcYieldDue(
                            cc,
                            principal,
                            (
                                await calendarContract.getDaysDiff(drawdownDate, nextDueDate)
                            ).toNumber(),
                        );
                        const expectedYieldDue = maxBigNumber(accruedYield, committedYield);
                        // Since the principal rate is 0, no principal is due. Only yield is due in the first
                        // partial period.
                        const expectedNewCR = {
                            ...cr,
                            ...{
                                nextDueDate: nextDueDate,
                                nextDue: expectedYieldDue,
                                yieldDue: expectedYieldDue,
                                remainingPeriods: BN.from(cr.remainingPeriods).sub(1),
                                state: CreditState.GoodStanding,
                            },
                        };
                        const expectedNewDD = {
                            ...dd,
                            ...{
                                committed: committedYield,
                                accrued: accruedYield,
                            },
                        };
                        checkCreditRecordsMatch(newCR, expectedNewCR);
                        checkDueDetailsMatch(newDD, expectedNewDD);
                    });
                });

                describe("If the principal rate is not 0", function () {
                    it("Should return the correct due date and amounts", async function () {
                        const timestamp = await getFutureBlockTime(1);
                        const drawdownDate = (
                            await calendarContract.getStartDateOfNextPeriod(
                                PayPeriodDuration.Monthly,
                                timestamp,
                            )
                        ).add(14 * CONSTANTS.SECONDS_IN_A_DAY);

                        const lateFeeBps = 500;
                        const principalRateInBps = 100;
                        await poolConfigContract.connect(poolOwner).setFeeStructure({
                            yieldInBps: 1000,
                            minPrincipalRateInBps: principalRateInBps,
                            lateFeeBps,
                        });
                        const [cc, cr, dd] = getInputParams(
                            {},
                            {
                                nextDue: 0,
                                yieldDue: 0,
                                nextDueDate: 0,
                                state: CreditState.Approved,
                            },
                        );
                        const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                            cr,
                            cc,
                            dd,
                            drawdownDate,
                        );
                        const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                            cc.periodDuration,
                            drawdownDate,
                        );
                        const principal = getPrincipal(cr, dd);
                        const [accruedYield, committedYield] = calcYieldDue(cc, principal, 16);
                        const expectedYieldDue = maxBigNumber(accruedYield, committedYield);
                        const [unbilledPrincipal, , expectedPrincipalDue] = await calcPrincipalDue(
                            calendarContract,
                            BN.from(cr.unbilledPrincipal),
                            drawdownDate.toNumber(),
                            Number(cr.nextDueDate),
                            nextDueDate.toNumber(),
                            PayPeriodDuration.Monthly,
                            principalRateInBps,
                        );
                        const expectedNewCR = {
                            ...cr,
                            ...{
                                unbilledPrincipal: unbilledPrincipal,
                                nextDueDate: nextDueDate,
                                nextDue: expectedPrincipalDue.add(expectedYieldDue),
                                yieldDue: expectedYieldDue,
                                remainingPeriods: BN.from(cr.remainingPeriods).sub(1),
                                state: CreditState.GoodStanding,
                            },
                        };
                        const expectedNewDD = {
                            ...dd,
                            ...{
                                committed: committedYield,
                                accrued: accruedYield,
                            },
                        };
                        checkCreditRecordsMatch(newCR, expectedNewCR);
                        checkDueDetailsMatch(newDD, expectedNewDD);
                    });
                });
            });

            describe("If the bill is late", function () {
                describe("If this is the first time the bill is late", function () {
                    describe("If the principal rate is 0", function () {
                        it("Should return the correct due date and amounts", async function () {
                            const nextYear = moment.utc().year() + 1;
                            const timestamp = moment.utc({
                                year: nextYear,
                                month: 3,
                                day: 14,
                            });

                            const lateFeeBps = 500;
                            await poolConfigContract.connect(poolOwner).setFeeStructure({
                                yieldInBps: 1000,
                                minPrincipalRateInBps: 0,
                                lateFeeBps,
                            });
                            const lastDueDate = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 1,
                            });
                            const [cc, cr, dd] = getInputParams(
                                {},
                                {
                                    nextDueDate: lastDueDate.unix(),
                                    state: CreditState.GoodStanding,
                                },
                                {
                                    lateFeeUpdatedDate: 0,
                                },
                            );
                            const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                                cr,
                                cc,
                                dd,
                                timestamp.unix(),
                            );
                            const nextDueDate = moment.utc({
                                year: nextYear,
                                month: 4,
                                day: 1,
                            });
                            const principal = getPrincipal(cr, dd);
                            // All yield prior to 4/1 are now past due.
                            const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
                                cc,
                                principal,
                                2 * CONSTANTS.DAYS_IN_A_MONTH,
                            );
                            const expectedYieldPastDue = maxBigNumber(
                                accruedYieldPastDue,
                                committedYieldPastDue,
                            );
                            const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFee(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                timestamp.unix(),
                            );
                            const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
                                cc,
                                principal,
                                CONSTANTS.DAYS_IN_A_MONTH,
                            );
                            const expectedYieldNextDue = maxBigNumber(
                                accruedYieldNextDue,
                                committedYieldNextDue,
                            );
                            const expectedNewCR = {
                                unbilledPrincipal: 0,
                                nextDueDate: nextDueDate.unix(),
                                nextDue: expectedYieldNextDue.add(BN.from(cr.unbilledPrincipal)),
                                yieldDue: expectedYieldNextDue,
                                totalPastDue: BN.from(cr.nextDue)
                                    .add(expectedYieldPastDue)
                                    .add(expectedLateFee),
                                missedPeriods: 3,
                                remainingPeriods: BN.from(cr.remainingPeriods).sub(3),
                                state: CreditState.Delayed,
                            };
                            const expectedNewDD = {
                                ...dd,
                                ...{
                                    lateFeeUpdatedDate: lateFeeUpdatedDate,
                                    lateFee: expectedLateFee,
                                    yieldPastDue: BN.from(cr.yieldDue).add(expectedYieldPastDue),
                                    principalPastDue: BN.from(cr.nextDue).sub(
                                        BN.from(cr.yieldDue),
                                    ),
                                    committed: committedYieldNextDue,
                                    accrued: accruedYieldNextDue,
                                },
                            };
                            checkCreditRecordsMatch(newCR, expectedNewCR);
                            checkDueDetailsMatch(newDD, expectedNewDD);
                        });
                    });

                    describe("If the principal rate is not 0", function () {
                        it("Should return the correct due date and amounts", async function () {
                            const nextYear = moment.utc().year() + 1;
                            const timestamp = moment.utc({
                                year: nextYear,
                                month: 3,
                                day: 14,
                            });

                            const lateFeeBps = 500;
                            const principalRateInBps = 100;
                            await poolConfigContract.connect(poolOwner).setFeeStructure({
                                yieldInBps: 1000,
                                minPrincipalRateInBps: principalRateInBps,
                                lateFeeBps,
                            });
                            const lastDueDate = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 1,
                            });
                            const [cc, cr, dd] = getInputParams(
                                {},
                                {
                                    nextDueDate: lastDueDate.unix(),
                                    state: CreditState.GoodStanding,
                                },
                                {
                                    lateFeeUpdatedDate: 0,
                                },
                            );
                            const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                                cr,
                                cc,
                                dd,
                                timestamp.unix(),
                            );
                            const nextDueDate = moment.utc({
                                year: nextYear,
                                month: 4,
                                day: 1,
                            });
                            const principal = getPrincipal(cr, dd);

                            // Calculate yield due.
                            const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
                                cc,
                                principal,
                                2 * CONSTANTS.DAYS_IN_A_MONTH,
                            );
                            const expectedYieldPastDue = maxBigNumber(
                                accruedYieldPastDue,
                                committedYieldPastDue,
                            );
                            const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFee(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                timestamp.unix(),
                            );
                            const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
                                cc,
                                principal,
                                CONSTANTS.DAYS_IN_A_MONTH,
                            );
                            const expectedYieldNextDue = maxBigNumber(
                                accruedYieldNextDue,
                                committedYieldNextDue,
                            );

                            // Calculate principal due.
                            const [
                                unbilledPrincipal,
                                expectedPrincipalPastDue,
                                expectedPrincipalNextDue,
                            ] = await calcPrincipalDue(
                                calendarContract,
                                BN.from(cr.unbilledPrincipal),
                                timestamp.unix(),
                                Number(cr.nextDueDate),
                                nextDueDate.unix(),
                                PayPeriodDuration.Monthly,
                                principalRateInBps,
                            );
                            const expectedNewCR = {
                                unbilledPrincipal: toToken(0),
                                nextDueDate: nextDueDate.unix(),
                                nextDue: expectedYieldNextDue
                                    .add(expectedPrincipalNextDue)
                                    .add(unbilledPrincipal),
                                yieldDue: expectedYieldNextDue,
                                totalPastDue: BN.from(cr.nextDue)
                                    .add(expectedPrincipalPastDue)
                                    .add(expectedYieldPastDue)
                                    .add(expectedLateFee),
                                missedPeriods: 3,
                                remainingPeriods: BN.from(cr.remainingPeriods).sub(3),
                                state: CreditState.Delayed,
                            };
                            const expectedNewDD = {
                                ...dd,
                                ...{
                                    lateFeeUpdatedDate: lateFeeUpdatedDate,
                                    lateFee: expectedLateFee,
                                    yieldPastDue: BN.from(cr.yieldDue).add(expectedYieldPastDue),
                                    principalPastDue: BN.from(cr.nextDue)
                                        .sub(BN.from(cr.yieldDue))
                                        .add(expectedPrincipalPastDue),
                                    committed: committedYieldNextDue,
                                    accrued: accruedYieldNextDue,
                                },
                            };
                            checkCreditRecordsMatch(newCR, expectedNewCR);
                            checkDueDetailsMatch(newDD, expectedNewDD);
                        });
                    });
                });

                describe("If the bill has been late in the past", function () {
                    describe("If the principal rate is 0", function () {
                        it("Should return the correct due date and amounts", async function () {
                            const nextYear = moment.utc().year() + 1;
                            const timestamp = moment.utc({
                                year: nextYear,
                                month: 3,
                                day: 14,
                            });

                            const lateFeeBps = 500;
                            await poolConfigContract.connect(poolOwner).setFeeStructure({
                                yieldInBps: 1000,
                                minPrincipalRateInBps: 0,
                                lateFeeBps,
                            });
                            const lastDueDate = moment.utc({
                                year: nextYear,
                                month: 2,
                                day: 1,
                            });
                            const [cc, cr, dd] = getInputParams(
                                {},
                                {
                                    nextDueDate: lastDueDate.unix(),
                                    totalPastDue: toToken(300),
                                    missedPeriods: 1,
                                    remainingPeriods: 2,
                                    state: CreditState.Delayed,
                                },
                                {
                                    lateFee: toToken(50),
                                    yieldPastDue: toToken(100),
                                    principalPastDue: toToken(200),
                                    paid: toToken(50),
                                },
                            );
                            const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                                cr,
                                cc,
                                dd,
                                timestamp.unix(),
                            );
                            const nextDueDate = moment.utc({
                                year: nextYear,
                                month: 4,
                                day: 1,
                            });
                            const principal = getPrincipal(cr, dd);
                            // All yield prior to 4/1 are now past due.
                            const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
                                cc,
                                principal,
                                CONSTANTS.DAYS_IN_A_MONTH,
                            );
                            const expectedYieldPastDue = maxBigNumber(
                                accruedYieldPastDue,
                                committedYieldPastDue,
                            );
                            const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFee(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                timestamp.unix(),
                            );
                            const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
                                cc,
                                principal,
                                CONSTANTS.DAYS_IN_A_MONTH,
                            );
                            const expectedYieldNextDue = maxBigNumber(
                                accruedYieldNextDue,
                                committedYieldNextDue,
                            );
                            const expectedNewCR = {
                                unbilledPrincipal: 0,
                                nextDueDate: nextDueDate.unix(),
                                nextDue: expectedYieldNextDue.add(BN.from(cr.unbilledPrincipal)),
                                yieldDue: expectedYieldNextDue,
                                totalPastDue: BN.from(cr.totalPastDue)
                                    .add(BN.from(cr.nextDue))
                                    .add(expectedYieldPastDue)
                                    .add(expectedLateFee),
                                missedPeriods: 3,
                                remainingPeriods: BN.from(cr.remainingPeriods).sub(2),
                                state: CreditState.Delayed,
                            };
                            const expectedNewDD = {
                                ...dd,
                                ...{
                                    lateFeeUpdatedDate: lateFeeUpdatedDate,
                                    lateFee: expectedLateFee,
                                    yieldPastDue: BN.from(dd.yieldPastDue)
                                        .add(BN.from(cr.yieldDue))
                                        .add(expectedYieldPastDue),
                                    principalPastDue: BN.from(dd.principalPastDue)
                                        .add(BN.from(cr.nextDue))
                                        .sub(BN.from(cr.yieldDue)),
                                    committed: committedYieldNextDue,
                                    accrued: accruedYieldNextDue,
                                    paid: 0,
                                },
                            };
                            checkCreditRecordsMatch(newCR, expectedNewCR);
                            checkDueDetailsMatch(newDD, expectedNewDD);
                        });
                    });

                    describe("If the principal rate is not 0", function () {
                        it("Should return the correct due date and amounts", async function () {
                            const nextYear = moment.utc().year() + 1;
                            const timestamp = moment.utc({
                                year: nextYear,
                                month: 3,
                                day: 14,
                            });

                            const lateFeeBps = 500;
                            const principalRateInBps = 100;
                            await poolConfigContract.connect(poolOwner).setFeeStructure({
                                yieldInBps: 1000,
                                minPrincipalRateInBps: principalRateInBps,
                                lateFeeBps,
                            });
                            const lastDueDate = moment.utc({
                                year: nextYear,
                                month: 2,
                                day: 1,
                            });
                            const [cc, cr, dd] = getInputParams(
                                {},
                                {
                                    nextDueDate: lastDueDate.unix(),
                                    totalPastDue: toToken(300),
                                    missedPeriods: 1,
                                    remainingPeriods: 2,
                                    state: CreditState.Delayed,
                                },
                                {
                                    lateFee: toToken(50),
                                    yieldPastDue: toToken(100),
                                    principalPastDue: toToken(200),
                                    paid: toToken(50),
                                },
                            );
                            const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                                cr,
                                cc,
                                dd,
                                timestamp.unix(),
                            );
                            const nextDueDate = moment.utc({
                                year: nextYear,
                                month: 4,
                                day: 1,
                            });
                            const principal = getPrincipal(cr, dd);

                            // Calculate yield due.
                            const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
                                cc,
                                principal,
                                CONSTANTS.DAYS_IN_A_MONTH,
                            );
                            const expectedYieldPastDue = maxBigNumber(
                                accruedYieldPastDue,
                                committedYieldPastDue,
                            );
                            const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFee(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                timestamp.unix(),
                            );
                            const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
                                cc,
                                principal,
                                CONSTANTS.DAYS_IN_A_MONTH,
                            );
                            const expectedYieldNextDue = maxBigNumber(
                                accruedYieldNextDue,
                                committedYieldNextDue,
                            );

                            // Calculate principal due.
                            const [
                                unbilledPrincipal,
                                expectedPrincipalPastDue,
                                expectedPrincipalNextDue,
                            ] = await calcPrincipalDue(
                                calendarContract,
                                BN.from(cr.unbilledPrincipal),
                                timestamp.unix(),
                                Number(cr.nextDueDate),
                                nextDueDate.unix(),
                                PayPeriodDuration.Monthly,
                                principalRateInBps,
                            );
                            const expectedNewCR = {
                                unbilledPrincipal: toToken(0),
                                nextDueDate: nextDueDate.unix(),
                                nextDue: expectedYieldNextDue
                                    .add(expectedPrincipalNextDue)
                                    .add(unbilledPrincipal),
                                yieldDue: expectedYieldNextDue,
                                totalPastDue: BN.from(cr.totalPastDue)
                                    .add(BN.from(cr.nextDue))
                                    .add(expectedPrincipalPastDue)
                                    .add(expectedYieldPastDue)
                                    .add(expectedLateFee),
                                missedPeriods: 3,
                                remainingPeriods: BN.from(cr.remainingPeriods).sub(2),
                                state: CreditState.Delayed,
                            };
                            const expectedNewDD = {
                                ...dd,
                                ...{
                                    lateFeeUpdatedDate: lateFeeUpdatedDate,
                                    lateFee: expectedLateFee,
                                    yieldPastDue: BN.from(dd.yieldPastDue)
                                        .add(BN.from(cr.yieldDue))
                                        .add(expectedYieldPastDue),
                                    principalPastDue: BN.from(dd.principalPastDue)
                                        .add(BN.from(cr.nextDue))
                                        .sub(BN.from(cr.yieldDue))
                                        .add(expectedPrincipalPastDue),
                                    committed: committedYieldNextDue,
                                    accrued: accruedYieldNextDue,
                                    paid: 0,
                                },
                            };
                            checkCreditRecordsMatch(newCR, expectedNewCR);
                            checkDueDetailsMatch(newDD, expectedNewDD);
                        });
                    });
                });

                describe("If the current block timestamp has surpassed the maturity date", function () {
                    it("Should return the correct due date and amounts", async function () {
                        const nextYear = moment.utc().year() + 1;
                        const timestamp = moment.utc({
                            year: nextYear,
                            month: 5,
                            day: 20,
                        });

                        const lateFeeBps = 500;
                        const principalRateInBps = 0;
                        await poolConfigContract.connect(poolOwner).setFeeStructure({
                            yieldInBps: 1000,
                            minPrincipalRateInBps: principalRateInBps,
                            lateFeeBps,
                        });
                        const lastDueDate = moment.utc({
                            year: nextYear,
                            month: 2,
                            day: 1,
                        });
                        const [cc, cr, dd] = getInputParams(
                            {},
                            {
                                nextDueDate: lastDueDate.unix(),
                                nextDue: toToken(1_000),
                                yieldDue: toToken(400),
                                totalPastDue: toToken(500),
                                missedPeriods: 1,
                                remainingPeriods: 2,
                                state: CreditState.Delayed,
                            },
                        );
                        const [newCR, newDD] = await creditDueManagerContract.getDueInfo(
                            cr,
                            cc,
                            dd,
                            timestamp.unix(),
                        );
                        const principal = getPrincipal(cr, dd);

                        // Calculate yield due.
                        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
                            cc,
                            principal,
                            CONSTANTS.DAYS_IN_A_MONTH,
                        );
                        const expectedYieldDue = maxBigNumber(accruedYieldDue, committedYieldDue);
                        const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
                            cc,
                            principal,
                            3 * CONSTANTS.DAYS_IN_A_MONTH,
                        );
                        const expectedYieldPastDue = maxBigNumber(
                            accruedYieldPastDue,
                            committedYieldPastDue,
                        );
                        const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFee(
                            poolConfigContract,
                            calendarContract,
                            cc,
                            cr,
                            dd,
                            timestamp.unix(),
                        );

                        // Calculate principal due.
                        const [, expectedPrincipalPastDue] = await calcPrincipalDue(
                            calendarContract,
                            BN.from(cr.unbilledPrincipal),
                            timestamp.unix(),
                            Number(cr.nextDueDate),
                            moment
                                .utc({
                                    year: nextYear,
                                    month: 5,
                                    day: 1,
                                })
                                .unix(),
                            PayPeriodDuration.Monthly,
                            principalRateInBps,
                        );
                        const expectedNewCR = {
                            unbilledPrincipal: toToken(0),
                            nextDueDate: moment
                                .utc({
                                    year: nextYear,
                                    month: 6,
                                    day: 1,
                                })
                                .unix(),
                            nextDue: expectedYieldDue,
                            yieldDue: expectedYieldDue,
                            totalPastDue: BN.from(cr.nextDue)
                                .add(expectedPrincipalPastDue)
                                .add(expectedYieldPastDue)
                                .add(expectedLateFee),
                            missedPeriods: 5,
                            remainingPeriods: 0,
                            state: CreditState.Delayed,
                        };
                        const expectedNewDD = {
                            ...dd,
                            ...{
                                lateFeeUpdatedDate: lateFeeUpdatedDate,
                                lateFee: expectedLateFee,
                                yieldPastDue: BN.from(cr.yieldDue).add(expectedYieldPastDue),
                                principalPastDue: BN.from(cr.nextDue)
                                    .sub(BN.from(cr.yieldDue))
                                    .add(expectedPrincipalPastDue),
                                committed: committedYieldDue,
                                accrued: accruedYieldDue,
                            },
                        };

                        checkCreditRecordsMatch(newCR, expectedNewCR);
                        checkDueDetailsMatch(newDD, expectedNewDD);
                    });
                });
            });
        });
    });

    describe("getPayoffAmount", function () {
        it("Should return the payoff amount", async function () {
            const creditRecord = {
                unbilledPrincipal: toToken(12_345),
                nextDueDate: Date.now(),
                nextDue: toToken(54_321),
                yieldDue: 0,
                totalPastDue: toToken(7_890),
                missedPeriods: 1,
                remainingPeriods: 0,
                state: CreditState.Delayed,
            };
            expect(await creditDueManagerContract.getPayoffAmount(creditRecord)).to.equal(
                creditRecord.unbilledPrincipal
                    .add(creditRecord.nextDue)
                    .add(creditRecord.totalPastDue),
            );
        });
    });
});
