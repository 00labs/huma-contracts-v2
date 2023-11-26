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
    EvaluationAgentNFT,
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
} from "../../typechain-types";
import {
    CreditConfigStruct,
    CreditRecordStruct,
    DueDetailStruct,
} from "../../typechain-types/contracts/credit/utils/CreditDueManager";
import {
    CONSTANTS,
    CreditState,
    PayPeriodDuration,
    calcLateFee,
    calcLateFeeNew,
    calcPrincipalDue,
    calcYieldDue,
    checkCreditRecordsMatch,
    checkDueDetailsMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    getPrincipal,
} from "../BaseTest";
import {
    getFutureBlockTime,
    maxBigNumber,
    mineNextBlockWithTimestamp,
    setNextBlockTimestamp,
    timestampToMoment,
    toToken,
} from "../TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress,
    protocolTreasury: SignerWithAddress,
    lender: SignerWithAddress;

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
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager;

describe("CreditDueManager Tests", function () {
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
            poolOperator,
            lender,
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
            "MockPoolCredit",
            evaluationAgent,
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
                "borrowingAmountLessThanPlatformFees",
            );
        });
    });

    describe("checkIsLate", function () {
        it("Should return true if there are missed periods", async function () {
            const creditRecord = {
                unbilledPrincipal: 0,
                nextDueDate: Date.now(),
                nextDue: 0,
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 1,
                remainingPeriods: 0,
                state: CreditState.Delayed,
            };
            expect(await creditDueManagerContract.checkIsLate(creditRecord)).to.be.true;
        });

        it("Should return true if there is payment due and we've already passed the payment grace period", async function () {
            const poolSettings = await poolConfigContract.getPoolSettings();
            // Advance next block time to be a second after the end of the late payment grace period.
            const nextBlockTime = timestampToMoment(await getFutureBlockTime(0))
                .add(poolSettings.latePaymentGracePeriodInDays, "days")
                .add(1, "second");
            await mineNextBlockWithTimestamp(nextBlockTime.unix());
            const creditRecord = {
                unbilledPrincipal: 0,
                nextDueDate: moment().unix(),
                nextDue: toToken(1_000),
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 0,
                remainingPeriods: 0,
                state: CreditState.GoodStanding,
            };
            expect(await creditDueManagerContract.checkIsLate(creditRecord)).to.be.true;
        });

        it("Should return false if there is no missed periods and no next due", async function () {
            const creditRecord = {
                unbilledPrincipal: 0,
                nextDueDate: 0,
                nextDue: 0,
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 0,
                remainingPeriods: 0,
                state: CreditState.Approved,
            };
            expect(await creditDueManagerContract.checkIsLate(creditRecord)).to.be.false;
        });

        it("Should return false if there is next due but we are not at the due date yet", async function () {
            const nextDueDate = timestampToMoment(Date.now()).add(1, "day");
            const creditRecord = {
                unbilledPrincipal: 0,
                nextDueDate: nextDueDate.unix(),
                nextDue: toToken(1_000),
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 0,
                remainingPeriods: 0,
                state: CreditState.Approved,
            };
            expect(await creditDueManagerContract.checkIsLate(creditRecord)).to.be.false;
        });
    });

    describe("getNextBillRefreshDate", function () {
        let nextYear: number, nextDueDate: moment.Moment, currentBlockTime: moment.Moment;
        const latePaymentGracePeriodInDays = 5;

        async function prepare() {
            await poolConfigContract
                .connect(poolOwner)
                .setLatePaymentGracePeriodInDays(latePaymentGracePeriodInDays);
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        describe("If the bill is currently in good standing and is within the current billing cycle", function () {
            async function setNextBlockTime() {
                currentBlockTime = moment.utc((await getFutureBlockTime(2)) * 1000);
                nextDueDate = currentBlockTime.clone().add(2, "days");
                await mineNextBlockWithTimestamp(currentBlockTime.unix());
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

        describe("If the bill is currently in good standing and is within the late payment grace period", function () {
            async function setNextBlockTime() {
                nextDueDate = moment.utc((await getFutureBlockTime(2)) * 1000);
                currentBlockTime = nextDueDate.clone().add(latePaymentGracePeriodInDays, "days");
                await mineNextBlockWithTimestamp(currentBlockTime.unix());
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

        describe("If the bill is currently in good standing but has surpassed the late payment grace period", function () {
            async function setNextBlockTime() {
                nextDueDate = moment.utc((await getFutureBlockTime(2)) * 1000);
                currentBlockTime = nextDueDate
                    .clone()
                    .add(latePaymentGracePeriodInDays, "days")
                    .add(1, "second");
                await mineNextBlockWithTimestamp(currentBlockTime.unix());
            }

            beforeEach(async function () {
                await loadFixture(setNextBlockTime);
            });

            it("Should return the previous due date", async function () {
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
                ).to.equal(nextDueDate.unix());
            });
        });

        describe("If the bill is already late", function () {
            async function setNextBlockTime() {
                nextDueDate = moment.utc((await getFutureBlockTime(2)) * 1000);
                currentBlockTime = nextDueDate.clone().add(latePaymentGracePeriodInDays, "days");
                await mineNextBlockWithTimestamp(currentBlockTime.unix());
            }

            beforeEach(async function () {
                await loadFixture(setNextBlockTime);
            });

            it("Should return the previous due date", async function () {
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

    describe("refreshLateFee", function () {
        let lateFeeFlat: BN, lateFeeBps: number;
        let nextYear: number, lastDueDate: moment.Moment, refreshDate: moment.Moment;

        async function prepare() {
            const [, , membershipFee] = await poolConfigContract.getFees();
            lateFeeFlat = toToken(100);
            lateFeeBps = 500;
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps: 1000,
                minPrincipalRateInBps: 10,
                lateFeeFlat,
                lateFeeBps,
                membershipFee,
            });

            nextYear = moment.utc().year() + 1;
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

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
                    numOfPeriods: 2,
                    yieldInBps: 1000,
                    advanceRateInBps: 8000,
                    revolving: true,
                    autoApproval: true,
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
                    remainingPeriods: 2,
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

        async function testRefreshLateFee(
            cc: CreditConfigStruct,
            cr: CreditRecordStruct,
            dd: DueDetailStruct,
            expectedLateFee: BN,
        ) {
            const [lateFeeUpdatedDate, lateFee] = await creditDueManagerContract.refreshLateFee(
                cc,
                cr,
                dd,
            );
            const dayAfterRefresh = refreshDate.clone().add(1, "day").startOf("day");
            expect(lateFeeUpdatedDate).to.equal(dayAfterRefresh.unix());
            expect(lateFee).to.equal(expectedLateFee);
        }

        describe("If the bill is currently in good standing", function () {
            describe("If the late fee is refreshed in the immediate next billing cycle", function () {
                async function prepareForRefresh() {
                    refreshDate = moment.utc({
                        year: nextYear,
                        month: 1,
                        day: 15,
                    });
                    await mineNextBlockWithTimestamp(refreshDate.unix());
                }

                beforeEach(async function () {
                    await loadFixture(prepareForRefresh);
                });

                it("Should return the correct late fee", async function () {
                    lastDueDate = moment.utc({
                        year: nextYear,
                        month: 1,
                        day: 1,
                    });
                    const [cc, cr, dd] = getInputParams({}, { nextDueDate: lastDueDate.unix() });
                    const expectedLateFee = await calcLateFee(
                        cr,
                        dd,
                        lateFeeFlat,
                        lateFeeBps,
                        15,
                        1,
                    );
                    await testRefreshLateFee(cc, cr, dd, expectedLateFee);
                });
            });

            describe("If the late fee is refreshed many billing cycles later", function () {
                async function prepareForRefresh() {
                    refreshDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 15,
                    });
                    await mineNextBlockWithTimestamp(refreshDate.unix());
                }

                beforeEach(async function () {
                    await loadFixture(prepareForRefresh);
                });

                it("Should return the correct late fee", async function () {
                    lastDueDate = moment.utc({
                        year: nextYear,
                        month: 1,
                        day: 1,
                    });
                    const [cc, cr, dd] = getInputParams({}, { nextDueDate: lastDueDate.unix() });
                    const expectedLateFee = await calcLateFee(
                        cr,
                        dd,
                        lateFeeFlat,
                        lateFeeBps,
                        45,
                        2,
                    );
                    await testRefreshLateFee(cc, cr, dd, expectedLateFee);
                });
            });

            describe("If the late fee is refreshed after the maturity date", function () {
                // TODO(jiatu): fill this in
            });
        });

        describe("If the bill is already late", function () {
            describe("If the late fee is refreshed within the current billing cycle", function () {
                async function prepareForRefresh() {
                    refreshDate = moment.utc({
                        year: nextYear,
                        month: 1,
                        day: 15,
                    });
                    await mineNextBlockWithTimestamp(refreshDate.unix());
                }

                beforeEach(async function () {
                    await loadFixture(prepareForRefresh);
                });

                it("Should return the correct late fee", async function () {
                    lastDueDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 1,
                    });
                    const existingLateFee = toToken(400);
                    const lateFeeUpdatedDate = moment.utc({
                        year: nextYear,
                        month: 1,
                        day: 10,
                    });
                    const [cc, cr, dd] = getInputParams(
                        {},
                        { nextDueDate: lastDueDate.unix(), state: CreditState.Delayed },
                        {
                            lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
                            lateFee: existingLateFee,
                        },
                    );
                    const expectedLateFee = (
                        await calcLateFee(cr, dd, lateFeeFlat, lateFeeBps, 6, 0)
                    ).add(existingLateFee);
                    await testRefreshLateFee(cc, cr, dd, expectedLateFee);
                });
            });

            describe("If the late fee is refreshed in the immediate next billing cycle", function () {
                async function prepareForRefresh() {
                    // TODO(jiatu): add a test case where day = 1. The current implementation of `getNumPeriodsPassed` is buggy,
                    // which prevents us from creating a test case like that one.
                    refreshDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 2,
                        hour: 0,
                        minute: 38,
                        second: 5,
                    });
                    await mineNextBlockWithTimestamp(refreshDate.unix());
                }

                beforeEach(async function () {
                    await loadFixture(prepareForRefresh);
                });

                it("Should return the correct late fee", async function () {
                    lastDueDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 1,
                    });
                    const existingLateFee = toToken(400);
                    const lateFeeUpdatedDate = moment.utc({
                        year: nextYear,
                        month: 1,
                        day: 10,
                    });
                    const [cc, cr, dd] = getInputParams(
                        {},
                        { nextDueDate: lastDueDate.unix(), state: CreditState.Delayed },
                        {
                            lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
                            lateFee: existingLateFee,
                        },
                    );
                    const expectedLateFee = (
                        await calcLateFee(cr, dd, lateFeeFlat, lateFeeBps, 23, 1)
                    ).add(existingLateFee);
                    await testRefreshLateFee(cc, cr, dd, expectedLateFee);
                });
            });

            describe("If the late fee is refreshed many billing cycles later", function () {
                async function prepareForRefresh() {
                    refreshDate = moment.utc({
                        year: nextYear,
                        month: 3,
                        day: 15,
                        hour: 0,
                        minute: 39,
                        second: 6,
                    });
                    await mineNextBlockWithTimestamp(refreshDate.unix());
                }

                beforeEach(async function () {
                    await loadFixture(prepareForRefresh);
                });

                it("Should return the correct late fee", async function () {
                    lastDueDate = moment.utc({
                        year: nextYear,
                        month: 2,
                        day: 1,
                    });
                    const existingLateFee = toToken(400);
                    const lateFeeUpdatedDate = moment.utc({
                        year: nextYear,
                        month: 1,
                        day: 10,
                    });
                    const [cc, cr, dd] = getInputParams(
                        {},
                        { nextDueDate: lastDueDate.unix(), state: CreditState.Delayed },
                        {
                            lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
                            lateFee: existingLateFee,
                        },
                    );
                    const expectedLateFee = (
                        await calcLateFee(cr, dd, lateFeeFlat, lateFeeBps, 66, 2)
                    ).add(existingLateFee);
                    await testRefreshLateFee(cc, cr, dd, expectedLateFee);
                });
            });

            describe("If the late fee is refreshed after the maturity date", function () {
                // TODO(jiatu): fill this in
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
                    numOfPeriods: 2,
                    yieldInBps: 1000,
                    advanceRateInBps: 8000,
                    revolving: true,
                    autoApproval: true,
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
                    remainingPeriods: 2,
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

        describe("When the current block timestamp is within the current billing cycle", function () {
            describe("If the current block timestamp is within the current billing cycle", function () {
                describe("If the bill is not late", function () {
                    it("Should return the CreditRecord and DueDetail as is", async function () {
                        const nextBlockTime = await getFutureBlockTime(2);
                        await setNextBlockTimestamp(nextBlockTime);

                        const [cc, cr, dd] = getInputParams(
                            {},
                            { nextDueDate: nextBlockTime + 1 },
                        );
                        const maturityDate = nextBlockTime + 5;
                        const [newCR, newDD, isLate] = await creditDueManagerContract.getDueInfo(
                            cr,
                            cc,
                            dd,
                            maturityDate,
                        );
                        checkCreditRecordsMatch(newCR, cr);
                        checkDueDetailsMatch(newDD, dd);
                        expect(isLate).to.be.false;
                    });
                });

                describe("If the bill is late", function () {
                    it("Should return updated CreditRecord and DueDetail with refreshed late fees", async function () {
                        const nextBlockTime = await getFutureBlockTime(2);
                        await setNextBlockTimestamp(nextBlockTime);

                        const [lateFeeFlat, , membershipFee] = await poolConfigContract.getFees();
                        const lateFeeBps = 500;
                        await poolConfigContract.connect(poolOwner).setFeeStructure({
                            yieldInBps: 1000,
                            minPrincipalRateInBps: 10,
                            lateFeeFlat,
                            lateFeeBps,
                            membershipFee,
                        });

                        const [cc, cr, dd] = getInputParams(
                            {},
                            {
                                nextDueDate: nextBlockTime + 1,
                                missedPeriods: 1,
                                state: CreditState.Delayed,
                            },
                        );
                        const maturityDate = nextBlockTime + 5;
                        const [newCR, newDD, isLate] = await creditDueManagerContract.getDueInfo(
                            cr,
                            cc,
                            dd,
                            maturityDate,
                        );
                        const poolSettings = await poolConfigContract.getPoolSettings();
                        const [lateFeeUpdatedDate, lateFee] = await calcLateFeeNew(
                            poolConfigContract,
                            calendarContract,
                            cc,
                            cr,
                            dd,
                            moment.utc(nextBlockTime * 1000),
                            poolSettings.latePaymentGracePeriodInDays,
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
                        expect(isLate).to.be.true;
                    });
                });
            });

            describe("If the current block timestamp has surpassed the due date of the last known billing cycle", function () {
                describe("If the bill is in good standing and the current block timestamp is still within the late payment grace period", function () {
                    it("Should return the CreditRecord and DueDetail as is", async function () {
                        const nextBlockTime = await getFutureBlockTime(2);
                        await setNextBlockTimestamp(nextBlockTime);

                        const latePaymentGracePeriodInDays = 5;
                        await poolConfigContract
                            .connect(poolOwner)
                            .setLatePaymentGracePeriodInDays(latePaymentGracePeriodInDays);

                        // Set the due date so that the current block timestamp falls within the late payment
                        // grace period.
                        const nextDueDate = moment(nextBlockTime * 1000)
                            .utc()
                            .subtract(latePaymentGracePeriodInDays, "days")
                            .add(1, "second")
                            .unix();
                        const [cc, cr, dd] = getInputParams(
                            {},
                            { nextDueDate: nextDueDate, state: CreditState.GoodStanding },
                        );
                        const maturityDate = nextBlockTime + 5;
                        const [newCR, newDD, isLate] = await creditDueManagerContract.getDueInfo(
                            cr,
                            cc,
                            dd,
                            maturityDate,
                        );
                        checkCreditRecordsMatch(newCR, cr);
                        checkDueDetailsMatch(newDD, dd);
                        expect(isLate).to.be.false;
                    });
                });

                describe("If this is the first drawdown", function () {
                    describe("If the principal rate is 0", function () {
                        it("Should return the correct due date and amounts", async function () {
                            const nextYear = moment.utc().year() + 1;
                            const nextBlockTime = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 14,
                            });
                            await setNextBlockTimestamp(nextBlockTime.unix());

                            const [lateFeeFlat, , membershipFee] =
                                await poolConfigContract.getFees();
                            const lateFeeBps = 500;
                            await poolConfigContract.connect(poolOwner).setFeeStructure({
                                yieldInBps: 1000,
                                minPrincipalRateInBps: 0,
                                lateFeeFlat,
                                lateFeeBps,
                                membershipFee,
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
                            const maturityDate = moment.utc({
                                year: nextYear,
                                month: 2,
                                day: 14,
                            });
                            const [newCR, newDD, isLate] =
                                await creditDueManagerContract.getDueInfo(
                                    cr,
                                    cc,
                                    dd,
                                    maturityDate.unix(),
                                );
                            const nextDueDate = moment.utc({
                                year: nextYear,
                                month: 2,
                                day: 1,
                            });
                            const principal = getPrincipal(cr, dd);
                            const [accruedYield, committedYield] = calcYieldDue(
                                cc,
                                principal,
                                17,
                                1,
                                membershipFee,
                            );
                            const expectedYieldDue = maxBigNumber(accruedYield, committedYield);
                            // Since the principal rate is 0, no principal is due. Only yield is due in the first
                            // partial period.
                            const expectedNewCR = {
                                ...cr,
                                ...{
                                    nextDueDate: nextDueDate.unix(),
                                    nextDue: expectedYieldDue,
                                    yieldDue: expectedYieldDue,
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
                            expect(isLate).to.be.false;
                        });
                    });

                    describe("If the principal rate is not 0", function () {
                        it("Should return the correct due date and amounts", async function () {
                            const nextYear = moment.utc().year() + 1;
                            const nextBlockTime = moment.utc({
                                year: nextYear,
                                month: 1,
                                day: 14,
                            });
                            await setNextBlockTimestamp(nextBlockTime.unix());

                            const [lateFeeFlat, , membershipFee] =
                                await poolConfigContract.getFees();
                            const lateFeeBps = 500;
                            const principalRateInBps = 100;
                            await poolConfigContract.connect(poolOwner).setFeeStructure({
                                yieldInBps: 1000,
                                minPrincipalRateInBps: principalRateInBps,
                                lateFeeFlat,
                                lateFeeBps,
                                membershipFee,
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
                            const maturityDate = moment.utc({
                                year: nextYear,
                                month: 2,
                                day: 14,
                            });
                            const [newCR, newDD, isLate] =
                                await creditDueManagerContract.getDueInfo(
                                    cr,
                                    cc,
                                    dd,
                                    maturityDate.unix(),
                                );
                            const nextDueDate = moment.utc({
                                year: nextYear,
                                month: 2,
                                day: 1,
                            });
                            const principal = getPrincipal(cr, dd);
                            const [accruedYield, committedYield] = calcYieldDue(
                                cc,
                                principal,
                                17,
                                1,
                                membershipFee,
                            );
                            const expectedYieldDue = maxBigNumber(accruedYield, committedYield);
                            // Since the principal rate is 0, no principal is due. Only yield is due in the first
                            // partial period.
                            const [unbilledPrincipal, , expectedPrincipalDue] =
                                await calcPrincipalDue(
                                    calendarContract,
                                    BN.from(cr.unbilledPrincipal),
                                    nextBlockTime.unix(),
                                    Number(cr.nextDueDate),
                                    nextDueDate.unix(),
                                    PayPeriodDuration.Monthly,
                                    principalRateInBps,
                                );
                            const expectedNewCR = {
                                ...cr,
                                ...{
                                    unbilledPrincipal: unbilledPrincipal,
                                    nextDueDate: nextDueDate.unix(),
                                    nextDue: expectedPrincipalDue.add(expectedYieldDue),
                                    yieldDue: expectedYieldDue,
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
                            expect(isLate).to.be.false;
                        });
                    });
                });

                describe("If the bill is late", function () {
                    describe("If this is the first time the bill is late", function () {
                        describe("If the principal rate is 0", function () {
                            it("Should return the correct due date and amounts", async function () {
                                const nextYear = moment.utc().year() + 1;
                                const nextBlockTime = moment.utc({
                                    year: nextYear,
                                    month: 3,
                                    day: 14,
                                });
                                await setNextBlockTimestamp(nextBlockTime.unix());

                                const [lateFeeFlat, , membershipFee] =
                                    await poolConfigContract.getFees();
                                const lateFeeBps = 500;
                                await poolConfigContract.connect(poolOwner).setFeeStructure({
                                    yieldInBps: 1000,
                                    minPrincipalRateInBps: 0,
                                    lateFeeFlat,
                                    lateFeeBps,
                                    membershipFee,
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
                                const maturityDate = moment.utc({
                                    year: nextYear,
                                    month: 5,
                                    day: 14,
                                });
                                const [newCR, newDD, isLate] =
                                    await creditDueManagerContract.getDueInfo(
                                        cr,
                                        cc,
                                        dd,
                                        maturityDate.unix(),
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
                                    60,
                                    3,
                                    membershipFee,
                                );
                                const expectedYieldPastDue = maxBigNumber(
                                    accruedYieldPastDue,
                                    committedYieldPastDue,
                                );
                                const poolSettings = await poolConfigContract.getPoolSettings();
                                const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFeeNew(
                                    poolConfigContract,
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    nextBlockTime,
                                    poolSettings.latePaymentGracePeriodInDays,
                                );
                                const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
                                    cc,
                                    principal,
                                    30,
                                    1,
                                    membershipFee,
                                );
                                const expectedYieldNextDue = maxBigNumber(
                                    accruedYieldNextDue,
                                    committedYieldNextDue,
                                );
                                const expectedNewCR = {
                                    ...cr,
                                    ...{
                                        nextDueDate: nextDueDate.unix(),
                                        nextDue: expectedYieldNextDue,
                                        yieldDue: expectedYieldNextDue,
                                        totalPastDue: BN.from(cr.nextDue)
                                            .add(expectedYieldPastDue)
                                            .add(expectedLateFee),
                                    },
                                };
                                const expectedNewDD = {
                                    ...dd,
                                    ...{
                                        lateFeeUpdatedDate: lateFeeUpdatedDate,
                                        lateFee: expectedLateFee,
                                        yieldPastDue: BN.from(cr.yieldDue).add(
                                            expectedYieldPastDue,
                                        ),
                                        principalPastDue: BN.from(cr.nextDue).sub(
                                            BN.from(cr.yieldDue),
                                        ),
                                        committed: committedYieldNextDue,
                                        accrued: accruedYieldNextDue,
                                    },
                                };
                                checkCreditRecordsMatch(newCR, expectedNewCR);
                                checkDueDetailsMatch(newDD, expectedNewDD);
                                expect(isLate).to.be.true;
                            });
                        });

                        describe("If the principal rate is not 0", function () {
                            it("Should return the correct due date and amounts", async function () {
                                const nextYear = moment.utc().year() + 1;
                                const nextBlockTime = moment.utc({
                                    year: nextYear,
                                    month: 3,
                                    day: 14,
                                });
                                await setNextBlockTimestamp(nextBlockTime.unix());

                                const [lateFeeFlat, , membershipFee] =
                                    await poolConfigContract.getFees();
                                const lateFeeBps = 500;
                                const principalRateInBps = 100;
                                await poolConfigContract.connect(poolOwner).setFeeStructure({
                                    yieldInBps: 1000,
                                    minPrincipalRateInBps: principalRateInBps,
                                    lateFeeFlat,
                                    lateFeeBps,
                                    membershipFee,
                                });
                                const poolSettings = await poolConfigContract.getPoolSettings();
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
                                const maturityDate = moment.utc({
                                    year: nextYear,
                                    month: 5,
                                    day: 14,
                                });
                                const [newCR, newDD, isLate] =
                                    await creditDueManagerContract.getDueInfo(
                                        cr,
                                        cc,
                                        dd,
                                        maturityDate.unix(),
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
                                    60,
                                    3,
                                    membershipFee,
                                );
                                const expectedYieldPastDue = maxBigNumber(
                                    accruedYieldPastDue,
                                    committedYieldPastDue,
                                );
                                const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFeeNew(
                                    poolConfigContract,
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    nextBlockTime,
                                    poolSettings.latePaymentGracePeriodInDays,
                                );
                                const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
                                    cc,
                                    principal,
                                    30,
                                    1,
                                    membershipFee,
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
                                    nextBlockTime.unix(),
                                    Number(cr.nextDueDate),
                                    nextDueDate.unix(),
                                    PayPeriodDuration.Monthly,
                                    principalRateInBps,
                                );
                                const expectedNewCR = {
                                    ...cr,
                                    ...{
                                        unbilledPrincipal: unbilledPrincipal,
                                        nextDueDate: nextDueDate.unix(),
                                        nextDue:
                                            expectedYieldNextDue.add(expectedPrincipalNextDue),
                                        yieldDue: expectedYieldNextDue,
                                        totalPastDue: BN.from(cr.nextDue)
                                            .add(expectedPrincipalPastDue)
                                            .add(expectedYieldPastDue)
                                            .add(expectedLateFee),
                                    },
                                };
                                const expectedNewDD = {
                                    ...dd,
                                    ...{
                                        lateFeeUpdatedDate: lateFeeUpdatedDate,
                                        lateFee: expectedLateFee,
                                        yieldPastDue: BN.from(cr.yieldDue).add(
                                            expectedYieldPastDue,
                                        ),
                                        principalPastDue: BN.from(cr.nextDue)
                                            .sub(BN.from(cr.yieldDue))
                                            .add(expectedPrincipalPastDue),
                                        committed: committedYieldNextDue,
                                        accrued: accruedYieldNextDue,
                                    },
                                };
                                checkCreditRecordsMatch(newCR, expectedNewCR);
                                checkDueDetailsMatch(newDD, expectedNewDD);
                                expect(isLate).to.be.true;
                            });
                        });
                    });

                    describe("If the bill has been late in the past", function () {
                        describe("If the principal rate is 0", function () {
                            it("Should return the correct due date and amounts", async function () {
                                const nextYear = moment.utc().year() + 1;
                                const nextBlockTime = moment.utc({
                                    year: nextYear,
                                    month: 3,
                                    day: 14,
                                });
                                await setNextBlockTimestamp(nextBlockTime.unix());

                                const [lateFeeFlat, , membershipFee] =
                                    await poolConfigContract.getFees();
                                const lateFeeBps = 500;
                                await poolConfigContract.connect(poolOwner).setFeeStructure({
                                    yieldInBps: 1000,
                                    minPrincipalRateInBps: 0,
                                    lateFeeFlat,
                                    lateFeeBps,
                                    membershipFee,
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
                                        totalPastDue: toToken(300),
                                        missedPeriods: 1,
                                        remainingPeriods: 1,
                                        state: CreditState.Delayed,
                                    },
                                    {
                                        lateFee: toToken(50),
                                        yieldPastDue: toToken(100),
                                        principalPastDue: toToken(200),
                                        paid: toToken(50),
                                    },
                                );
                                const maturityDate = moment.utc({
                                    year: nextYear,
                                    month: 5,
                                    day: 14,
                                });
                                const [newCR, newDD, isLate] =
                                    await creditDueManagerContract.getDueInfo(
                                        cr,
                                        cc,
                                        dd,
                                        maturityDate.unix(),
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
                                    60,
                                    3,
                                    membershipFee,
                                );
                                const expectedYieldPastDue = maxBigNumber(
                                    accruedYieldPastDue,
                                    committedYieldPastDue,
                                );
                                const poolSettings = await poolConfigContract.getPoolSettings();
                                const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFeeNew(
                                    poolConfigContract,
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    nextBlockTime,
                                    poolSettings.latePaymentGracePeriodInDays,
                                );
                                const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
                                    cc,
                                    principal,
                                    30,
                                    1,
                                    membershipFee,
                                );
                                const expectedYieldNextDue = maxBigNumber(
                                    accruedYieldNextDue,
                                    committedYieldNextDue,
                                );
                                const expectedNewCR = {
                                    ...cr,
                                    ...{
                                        nextDueDate: nextDueDate.unix(),
                                        nextDue: expectedYieldNextDue,
                                        yieldDue: expectedYieldNextDue,
                                        totalPastDue: BN.from(cr.totalPastDue)
                                            .add(BN.from(cr.nextDue))
                                            .add(expectedYieldPastDue)
                                            .add(expectedLateFee),
                                    },
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
                                expect(isLate).to.be.true;
                            });
                        });

                        describe("If the principal rate is not 0", function () {
                            it("Should return the correct due date and amounts", async function () {
                                const nextYear = moment.utc().year() + 1;
                                const nextBlockTime = moment.utc({
                                    year: nextYear,
                                    month: 3,
                                    day: 14,
                                });
                                await setNextBlockTimestamp(nextBlockTime.unix());

                                const [lateFeeFlat, , membershipFee] =
                                    await poolConfigContract.getFees();
                                const lateFeeBps = 500;
                                const principalRateInBps = 100;
                                await poolConfigContract.connect(poolOwner).setFeeStructure({
                                    yieldInBps: 1000,
                                    minPrincipalRateInBps: principalRateInBps,
                                    lateFeeFlat,
                                    lateFeeBps,
                                    membershipFee,
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
                                        totalPastDue: toToken(300),
                                        missedPeriods: 1,
                                        remainingPeriods: 1,
                                        state: CreditState.Delayed,
                                    },
                                    {
                                        lateFee: toToken(50),
                                        yieldPastDue: toToken(100),
                                        principalPastDue: toToken(200),
                                        paid: toToken(50),
                                    },
                                );
                                const maturityDate = moment.utc({
                                    year: nextYear,
                                    month: 5,
                                    day: 14,
                                });
                                const [newCR, newDD, isLate] =
                                    await creditDueManagerContract.getDueInfo(
                                        cr,
                                        cc,
                                        dd,
                                        maturityDate.unix(),
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
                                    60,
                                    3,
                                    membershipFee,
                                );
                                const expectedYieldPastDue = maxBigNumber(
                                    accruedYieldPastDue,
                                    committedYieldPastDue,
                                );
                                const poolSettings = await poolConfigContract.getPoolSettings();
                                const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFeeNew(
                                    poolConfigContract,
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    nextBlockTime,
                                    poolSettings.latePaymentGracePeriodInDays,
                                );
                                const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
                                    cc,
                                    principal,
                                    30,
                                    1,
                                    membershipFee,
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
                                    nextBlockTime.unix(),
                                    Number(cr.nextDueDate),
                                    nextDueDate.unix(),
                                    PayPeriodDuration.Monthly,
                                    principalRateInBps,
                                );
                                const expectedNewCR = {
                                    ...cr,
                                    ...{
                                        unbilledPrincipal: unbilledPrincipal,
                                        nextDueDate: nextDueDate.unix(),
                                        nextDue:
                                            expectedYieldNextDue.add(expectedPrincipalNextDue),
                                        yieldDue: expectedYieldNextDue,
                                        totalPastDue: BN.from(cr.totalPastDue)
                                            .add(BN.from(cr.nextDue))
                                            .add(expectedPrincipalPastDue)
                                            .add(expectedYieldPastDue)
                                            .add(expectedLateFee),
                                    },
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
                                expect(isLate).to.be.true;
                            });
                        });
                    });

                    describe("If the current block timestamp has surpassed the maturity date", function () {
                        it("Should return the correct due date and amounts", async function () {
                            const nextYear = moment.utc().year() + 1;
                            const nextBlockTime = moment.utc({
                                year: nextYear,
                                month: 5,
                                day: 20,
                            });
                            await setNextBlockTimestamp(nextBlockTime.unix());

                            const [lateFeeFlat, , membershipFee] =
                                await poolConfigContract.getFees();
                            const lateFeeBps = 500;
                            const principalRateInBps = 0;
                            await poolConfigContract.connect(poolOwner).setFeeStructure({
                                yieldInBps: 1000,
                                minPrincipalRateInBps: principalRateInBps,
                                lateFeeFlat,
                                lateFeeBps,
                                membershipFee,
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
                                    state: CreditState.Delayed,
                                },
                            );
                            const maturityDate = moment.utc({
                                year: nextYear,
                                month: 5,
                                day: 14,
                            });
                            const [newCR, newDD, isLate] =
                                await creditDueManagerContract.getDueInfo(
                                    cr,
                                    cc,
                                    dd,
                                    maturityDate.unix(),
                                );
                            const principal = getPrincipal(cr, dd);

                            // Calculate yield due.
                            const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
                                cc,
                                principal,
                                133,
                                5,
                                membershipFee,
                            );
                            const expectedYieldPastDue = maxBigNumber(
                                accruedYieldPastDue,
                                committedYieldPastDue,
                            );
                            const poolSettings = await poolConfigContract.getPoolSettings();
                            const [lateFeeUpdatedDate, expectedLateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                nextBlockTime,
                                poolSettings.latePaymentGracePeriodInDays,
                            );
                            const [accruedYieldNextDue, committedYieldNextDue] = calcYieldDue(
                                cc,
                                principal,
                                0,
                                1,
                                membershipFee,
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
                                nextBlockTime.unix(),
                                Number(cr.nextDueDate),
                                maturityDate.unix(),
                                PayPeriodDuration.Monthly,
                                principalRateInBps,
                            );
                            const expectedNewCR = {
                                ...cr,
                                ...{
                                    unbilledPrincipal: unbilledPrincipal,
                                    nextDueDate: maturityDate.unix(),
                                    nextDue: expectedYieldNextDue.add(expectedPrincipalNextDue),
                                    yieldDue: expectedYieldNextDue,
                                    totalPastDue: BN.from(cr.nextDue)
                                        .add(expectedPrincipalPastDue)
                                        .add(expectedYieldPastDue)
                                        .add(expectedLateFee),
                                },
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
                            expect(isLate).to.be.true;
                        });
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
