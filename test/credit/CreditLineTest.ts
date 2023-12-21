import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import moment from "moment";
import {
    BorrowerLevelCreditManager,
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
    CreditRecordStruct,
    DueDetailStruct,
} from "../../typechain-types/contracts/credit/Credit";
import {
    CONSTANTS,
    CreditClosureReason,
    CreditState,
    PayPeriodDuration,
    calcLateFeeNew,
    calcPrincipalDueForFullPeriods,
    calcPrincipalDueForPartialPeriod,
    calcPrincipalDueNew,
    calcYield,
    calcYieldDue,
    calcYieldDueNew,
    checkCreditConfig,
    checkCreditRecord,
    checkCreditRecordsMatch,
    checkDueDetailsMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    genDueDetail,
    getLatePaymentGracePeriodDeadline,
    getNextBillRefreshDate,
} from "../BaseTest";
import {
    borrowerLevelCreditHash,
    getFutureBlockTime,
    getLatestBlock,
    getMinFirstLossCoverRequirement,
    getStartOfDay,
    isCloseTo,
    maxBigNumber,
    minBigNumber,
    mineNextBlockWithTimestamp,
    setNextBlockTimestamp,
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
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: BorrowerLevelCreditManager;

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
            creditManagerContract as unknown,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "CreditLine",
            "BorrowerLevelCreditManager",
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
                (
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        borrower.address,
                    )
                ).mul(2),
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
                (
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        borrower2.address,
                    )
                ).mul(2),
            );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("getDueInfo", function () {
        const yieldInBps = 1217,
            principalRate = 100,
            lateFeeBps = 2400;
        const numOfPeriods = 3,
            latePaymentGracePeriodInDays = 5;
        let committedAmount: BN, borrowAmount: BN;
        let creditHash: string;

        async function prepare() {
            await poolConfigContract
                .connect(poolOwner)
                .setLatePaymentGracePeriodInDays(latePaymentGracePeriodInDays);
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps: yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps: lateFeeBps,
            });

            committedAmount = toToken(10_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    numOfPeriods,
                    yieldInBps,
                    committedAmount,
                    0,
                    true,
                );
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        it("Should return the latest bill for the borrower", async function () {
            borrowAmount = toToken(15_000);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            const oldCR = await creditContract.getCreditRecord(creditHash);
            const viewTime =
                oldCR.nextDueDate.toNumber() +
                latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                100;
            await mineNextBlockWithTimestamp(viewTime);

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                cc.periodDuration,
                viewTime,
            );
            const [accruedYieldDue, committedYieldDue] = calcYieldDue(
                cc,
                borrowAmount,
                CONSTANTS.DAYS_IN_A_MONTH,
            );
            expect(accruedYieldDue).to.be.gt(committedYieldDue);
            const principalDue = calcPrincipalDueForFullPeriods(
                oldCR.unbilledPrincipal,
                principalRate,
                1,
            );
            const nextDue = accruedYieldDue.add(principalDue);
            const tomorrow = await calendarContract.getStartOfTomorrow();
            const lateFee = calcYield(borrowAmount, lateFeeBps, latePaymentGracePeriodInDays + 1);
            expect(lateFee).to.be.gt(0);

            const [actualCR, actualDD] = await creditContract.getDueInfo(borrower.getAddress());
            const expectedCR = {
                unbilledPrincipal: oldCR.unbilledPrincipal.sub(principalDue),
                nextDueDate,
                nextDue,
                yieldDue: accruedYieldDue,
                totalPastDue: oldCR.nextDue.add(lateFee),
                missedPeriods: 1,
                remainingPeriods: oldCR.remainingPeriods - 1,
                state: CreditState.Delayed,
            };
            checkCreditRecordsMatch(actualCR, expectedCR);
            const expectedDD = genDueDetail({
                lateFeeUpdatedDate: tomorrow,
                lateFee: lateFee,
                yieldPastDue: oldCR.yieldDue,
                principalPastDue: oldCR.nextDue.sub(oldCR.yieldDue),
                accrued: accruedYieldDue,
                committed: committedYieldDue,
            });
            checkDueDetailsMatch(actualDD, expectedDD);
        });
    });

    describe("approveBorrower", function () {
        it("Should not approve when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        0,
                        true,
                    ),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        0,
                        true,
                    ),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
        });

        it("Should not allow non-EA service account to approve", async function () {
            await expect(
                creditManagerContract.approveBorrower(
                    borrower.address,
                    toToken(10_000),
                    1,
                    1217,
                    toToken(10_000),
                    0,
                    true,
                ),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "evaluationAgentServiceAccountRequired",
            );
        });

        it("Should not approve with invalid parameters", async function () {
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        ethers.constants.AddressZero,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        0,
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditManagerContract, "zeroAddressProvided");

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(0),
                        1,
                        1217,
                        toToken(10_000),
                        0,
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditManagerContract, "zeroAmountProvided");

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        0,
                        1217,
                        toToken(10_000),
                        0,
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditManagerContract, "zeroPayPeriods");

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_001),
                        0,
                        true,
                    ),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "committedAmountGreaterThanCreditLimit",
            );

            let poolSettings = await poolConfigContract.getPoolSettings();
            let creditLimit = poolSettings.maxCreditLine.add(1);

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        creditLimit,
                        1,
                        1217,
                        toToken(10_000),
                        0,
                        true,
                    ),
            ).to.be.revertedWithCustomError(creditManagerContract, "greaterThanMaxCreditLine");

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(10_000),
                    1,
                    1217,
                    toToken(10_000),
                    0,
                    true,
                );
            await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        0,
                        true,
                    ),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "creditLineNotInStateForUpdate",
            );
        });

        it("Should not approve if the credit has no commitment but a designated start date", async function () {
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.getAddress(),
                        toToken(10_000),
                        1,
                        1217,
                        0,
                        moment.utc().unix(),
                        true,
                    ),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "creditWithoutCommitmentShouldHaveNoDesignatedStartDate",
            );
        });

        it("Should not approve if the designated start date is in the past", async function () {
            const nextBlockTimestamp = await getFutureBlockTime(2);
            await setNextBlockTimestamp(nextBlockTimestamp);
            const designatedStartDate = moment
                .utc(nextBlockTimestamp * 1000)
                .subtract(1, "day")
                .startOf("day");

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.getAddress(),
                        toToken(10_000),
                        1,
                        1217,
                        0,
                        designatedStartDate.unix(),
                        true,
                    ),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "creditWithoutCommitmentShouldHaveNoDesignatedStartDate",
            );
        });

        it("Should approve a borrower correctly", async function () {
            const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            let poolSettings = await poolConfigContract.getPoolSettings();

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        1,
                        1217,
                        toToken(10_000),
                        0,
                        true,
                    ),
            )
                .to.emit(creditManagerContract, "CreditConfigChanged")
                .withArgs(
                    creditHash,
                    toToken(10_000),
                    toToken(10_000),
                    poolSettings.payPeriodDuration,
                    1,
                    1217,
                    true,
                    poolSettings.advanceRateInBps,
                    false,
                )
                .to.emit(creditManagerContract, "CreditLineApproved")
                .withArgs(
                    borrower.address,
                    creditHash,
                    toToken(10_000),
                    poolSettings.payPeriodDuration,
                    1,
                    1217,
                    toToken(10_000),
                    true,
                );

            let creditConfig = await creditManagerContract.getCreditConfig(creditHash);
            checkCreditConfig(
                creditConfig,
                toToken(10_000),
                toToken(10_000),
                poolSettings.payPeriodDuration,
                1,
                1217,
                true,
                poolSettings.advanceRateInBps,
                false,
            );

            let cr = await creditContract.getCreditRecord(creditHash);
            checkCreditRecord(
                cr,
                BN.from(0),
                0,
                BN.from(0),
                BN.from(0),
                BN.from(0),
                0,
                1,
                CreditState.Approved,
            );
            expect(await creditManagerContract.getCreditBorrower(creditHash)).to.equal(
                borrower.address,
            );
        });

        it("Should approve again after a credit is closed", async function () {
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(borrower.address, toToken(10_000), 1, 1217, toToken(0), 0, true);

            await creditManagerContract.connect(borrower).closeCredit(borrower.address);

            const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            let poolSettings = await poolConfigContract.getPoolSettings();

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(20_000),
                        3,
                        1217,
                        toToken(20_000),
                        0,
                        true,
                    ),
            )
                .to.emit(creditManagerContract, "CreditConfigChanged")
                .withArgs(
                    creditHash,
                    toToken(20_000),
                    toToken(20_000),
                    poolSettings.payPeriodDuration,
                    3,
                    1217,
                    true,
                    poolSettings.advanceRateInBps,
                    false,
                )
                .to.emit(creditManagerContract, "CreditLineApproved")
                .withArgs(
                    borrower.address,
                    creditHash,
                    toToken(20_000),
                    poolSettings.payPeriodDuration,
                    3,
                    1217,
                    toToken(20_000),
                    true,
                );

            let creditConfig = await creditManagerContract.getCreditConfig(creditHash);
            checkCreditConfig(
                creditConfig,
                toToken(20_000),
                toToken(20_000),
                poolSettings.payPeriodDuration,
                3,
                1217,
                true,
                poolSettings.advanceRateInBps,
                false,
            );

            const cr = await creditContract.getCreditRecord(creditHash);
            checkCreditRecord(
                cr,
                BN.from(0),
                0,
                BN.from(0),
                BN.from(0),
                BN.from(0),
                0,
                3,
                CreditState.Approved,
            );
            expect(await creditManagerContract.getCreditBorrower(creditHash)).to.equal(
                borrower.address,
            );
        });

        it("Should approve with a designated start date", async function () {
            const block = await getLatestBlock();
            const nextTime = block.timestamp + 100;
            await setNextBlockTimestamp(nextTime);
            const designatedStartDate = moment
                .utc(nextTime * 1000)
                .add(5, "days")
                .startOf("day");

            const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            const poolSettings = await poolConfigContract.getPoolSettings();

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        3,
                        1217,
                        toToken(10_000),
                        designatedStartDate.unix(),
                        true,
                    ),
            )
                .to.emit(creditManagerContract, "CreditConfigChanged")
                .withArgs(
                    creditHash,
                    toToken(10_000),
                    toToken(10_000),
                    poolSettings.payPeriodDuration,
                    3,
                    1217,
                    true,
                    poolSettings.advanceRateInBps,
                    false,
                )
                .to.emit(creditManagerContract, "CreditLineApproved")
                .withArgs(
                    borrower.address,
                    creditHash,
                    toToken(10_000),
                    poolSettings.payPeriodDuration,
                    3,
                    1217,
                    toToken(10_000),
                    true,
                );

            const creditConfig = await creditManagerContract.getCreditConfig(creditHash);
            checkCreditConfig(
                creditConfig,
                toToken(10_000),
                toToken(10_000),
                poolSettings.payPeriodDuration,
                3,
                1217,
                true,
                poolSettings.advanceRateInBps,
                false,
            );

            const cr = await creditContract.getCreditRecord(creditHash);
            checkCreditRecord(
                cr,
                BN.from(0),
                designatedStartDate.unix(),
                BN.from(0),
                BN.from(0),
                BN.from(0),
                0,
                3,
                CreditState.Approved,
            );
            expect(await creditManagerContract.getCreditBorrower(creditHash)).to.equal(
                borrower.address,
            );
        });
    });

    describe("startCommittedCredit", function () {
        const yieldInBps = 1317,
            remainingPeriods = 6;
        let committedAmount: BN;
        let creditHash: string;
        let startDate: BN;

        describe("If the designated start date is at the beginning of a period", function () {
            async function prepare() {
                committedAmount = toToken(50_000);
                creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                const nextBlockTimestamp = await getFutureBlockTime(1);
                startDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextBlockTimestamp,
                );
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.getAddress(),
                        toToken(100_000),
                        remainingPeriods,
                        yieldInBps,
                        committedAmount,
                        startDate,
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(prepare);
            });

            it("Should start a credit with commitment", async function () {
                await setNextBlockTimestamp(startDate);
                await expect(
                    creditManagerContract
                        .connect(pdsServiceAccount)
                        .startCommittedCredit(borrower.getAddress()),
                )
                    .to.emit(creditManagerContract, "CommittedCreditStarted")
                    .withArgs(creditHash);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedYieldDue = calcYield(
                    committedAmount,
                    yieldInBps,
                    CONSTANTS.DAYS_IN_A_MONTH,
                );
                const expectedNextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    startDate,
                );
                const expectedCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedNextDueDate,
                    nextDue: expectedYieldDue,
                    yieldDue: expectedYieldDue,
                    totalPastDue: BN.from(0),
                    missedPeriods: 0,
                    remainingPeriods: remainingPeriods - 1,
                    state: CreditState.GoodStanding,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);
                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = genDueDetail({
                    committed: expectedYieldDue,
                });
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should start a credit with commitment even if the current timestamp is not the same as the start date", async function () {
                const runDate = startDate.toNumber() + 5 * CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(runDate);
                await expect(
                    creditManagerContract
                        .connect(pdsServiceAccount)
                        .startCommittedCredit(borrower.getAddress()),
                )
                    .to.emit(creditManagerContract, "CommittedCreditStarted")
                    .withArgs(creditHash);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedYieldDue = calcYield(
                    committedAmount,
                    yieldInBps,
                    CONSTANTS.DAYS_IN_A_MONTH,
                );
                const expectedNextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    startDate,
                );
                const expectedCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedNextDueDate,
                    nextDue: expectedYieldDue,
                    yieldDue: expectedYieldDue,
                    totalPastDue: BN.from(0),
                    missedPeriods: 0,
                    remainingPeriods: remainingPeriods - 1,
                    state: CreditState.GoodStanding,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);
                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = genDueDetail({
                    committed: expectedYieldDue,
                });
                checkDueDetailsMatch(actualDD, expectedDD);
            });
        });

        describe("If the designated start date is in the middle of a period", function () {
            async function prepare() {
                committedAmount = toToken(50_000);
                creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                const nextBlockTimestamp = await getFutureBlockTime(1);
                startDate = (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        nextBlockTimestamp,
                    )
                ).add(CONSTANTS.SECONDS_IN_A_DAY * 13);
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.getAddress(),
                        toToken(100_000),
                        remainingPeriods,
                        yieldInBps,
                        committedAmount,
                        startDate,
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(prepare);
            });

            it("Should start a credit with commitment", async function () {
                await setNextBlockTimestamp(startDate);
                await expect(
                    creditManagerContract
                        .connect(pdsServiceAccount)
                        .startCommittedCredit(borrower.getAddress()),
                )
                    .to.emit(creditManagerContract, "CommittedCreditStarted")
                    .withArgs(creditHash);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedNextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    startDate,
                );
                const daysPassed = await calendarContract.getDaysDiff(
                    startDate,
                    expectedNextDueDate,
                );
                expect(daysPassed).to.be.lt(CONSTANTS.DAYS_IN_A_MONTH);
                const expectedYieldDue = calcYield(
                    committedAmount,
                    yieldInBps,
                    daysPassed.toNumber(),
                );
                const expectedCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedNextDueDate,
                    nextDue: expectedYieldDue,
                    yieldDue: expectedYieldDue,
                    totalPastDue: BN.from(0),
                    missedPeriods: 0,
                    remainingPeriods: remainingPeriods - 1,
                    state: CreditState.GoodStanding,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);
                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = genDueDetail({
                    committed: expectedYieldDue,
                });
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should start a credit with commitment even if the current timestamp is not the same as the start date", async function () {
                const runDate = startDate.toNumber() + 5 * CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(runDate);
                await expect(
                    creditManagerContract
                        .connect(pdsServiceAccount)
                        .startCommittedCredit(borrower.getAddress()),
                )
                    .to.emit(creditManagerContract, "CommittedCreditStarted")
                    .withArgs(creditHash);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedNextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    startDate,
                );
                const daysPassed = await calendarContract.getDaysDiff(
                    startDate,
                    expectedNextDueDate,
                );
                expect(daysPassed).to.be.lt(CONSTANTS.DAYS_IN_A_MONTH);
                const expectedYieldDue = calcYield(
                    committedAmount,
                    yieldInBps,
                    daysPassed.toNumber(),
                );
                const expectedCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedNextDueDate,
                    nextDue: expectedYieldDue,
                    yieldDue: expectedYieldDue,
                    totalPastDue: BN.from(0),
                    missedPeriods: 0,
                    remainingPeriods: remainingPeriods - 1,
                    state: CreditState.GoodStanding,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);
                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = genDueDetail({
                    committed: expectedYieldDue,
                });
                checkDueDetailsMatch(actualDD, expectedDD);
            });
        });

        it("Should not start a credit if the protocol or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract
                    .connect(pdsServiceAccount)
                    .startCommittedCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract
                    .connect(pdsServiceAccount)
                    .startCommittedCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
        });

        it("Should not allow non-pds service accounts or pool owner to start a credit", async function () {
            await expect(
                creditManagerContract
                    .connect(borrower)
                    .startCommittedCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
        });

        it("Should not start a credit for a borrower without an approved credit", async function () {
            await expect(
                creditManagerContract
                    .connect(pdsServiceAccount)
                    .startCommittedCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(creditContract, "notBorrower");
        });

        it("Should not start a credit that's in the wrong state", async function () {
            committedAmount = toToken(50_000);

            const nextBlockTimestamp = await getFutureBlockTime(1);
            startDate = await calendarContract.getStartDateOfNextPeriod(
                PayPeriodDuration.Monthly,
                nextBlockTimestamp,
            );
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    remainingPeriods,
                    yieldInBps,
                    committedAmount,
                    startDate,
                    true,
                );
            const drawdownDate = startDate.add(CONSTANTS.SECONDS_IN_A_DAY);
            await setNextBlockTimestamp(drawdownDate);
            await creditContract
                .connect(borrower)
                .drawdown(borrower.getAddress(), toToken(20_000));
            await expect(
                creditManagerContract
                    .connect(pdsServiceAccount)
                    .startCommittedCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "committedCreditCannotBeStarted",
            );
        });

        it("Should not start a credit that does not have a designated start date", async function () {
            committedAmount = toToken(50_000);
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    remainingPeriods,
                    yieldInBps,
                    committedAmount,
                    0,
                    true,
                );
            await expect(
                creditManagerContract
                    .connect(pdsServiceAccount)
                    .startCommittedCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "committedCreditCannotBeStarted",
            );
        });

        it("Should not start a credit before the designated date", async function () {
            committedAmount = toToken(50_000);

            const nextBlockTimestamp = await getFutureBlockTime(1);
            startDate = await calendarContract.getStartDateOfNextPeriod(
                PayPeriodDuration.Monthly,
                nextBlockTimestamp,
            );
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    remainingPeriods,
                    yieldInBps,
                    committedAmount,
                    startDate,
                    true,
                );
            const kickOffDate = startDate.sub(1);
            await setNextBlockTimestamp(kickOffDate);
            await expect(
                creditManagerContract
                    .connect(pdsServiceAccount)
                    .startCommittedCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "committedCreditCannotBeStarted",
            );
        });
    });

    describe("drawdown", function () {
        let yieldInBps = 1217;
        let numOfPeriods = 5;

        describe("Without commitment", function () {
            async function prepareForDrawdown() {
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        numOfPeriods,
                        yieldInBps,
                        toToken(0),
                        0,
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(prepareForDrawdown);
            });

            it("Should not allow drawdown when the protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            });

            it("Should not allow drawdown with invalid parameters", async function () {
                await expect(
                    creditContract.connect(borrower).drawdown(borrower2.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");

                await expect(
                    creditContract.connect(borrower2).drawdown(borrower2.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(0)),
                ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(100_001)),
                ).to.be.revertedWithCustomError(creditContract, "creditLineExceeded");
            });

            it("Should not allow drawdown if the credit line is closed", async function () {
                await creditManagerContract.connect(borrower).closeCredit(borrower.address);

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(creditContract, "creditNotInStateForDrawdown");
            });

            it("Should not allow drawdown if the bill enters the late payment grace period for the first time while in good standing", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const borrowAmount = toToken(50_000);
                const firstDrawdownDate = await getFutureBlockTime(3);
                await setNextBlockTimestamp(firstDrawdownDate);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);
                const cr = await creditContract.getCreditRecord(creditHash);
                const poolSettings = await poolConfigContract.getPoolSettings();
                const secondDrawdownDate =
                    cr.nextDueDate.toNumber() +
                    (poolSettings.latePaymentGracePeriodInDays - 1) * CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(secondDrawdownDate);
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "drawdownNotAllowedInLatePaymentGracePeriod",
                );
            });

            it("Should not allow drawdown when the credit state is Delayed", async function () {
                await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));
                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);
                let cr = await creditContract.getCreditRecord(creditHash);
                let settings = await poolConfigContract.getPoolSettings();
                let nextTime =
                    cr.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextTime);

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "drawdownNotAllowedInLatePaymentGracePeriod",
                );
            });

            it("Should not allow drawdown when the credit state is Defaulted", async function () {
                const defaultGracePeriodInMonths = 1;
                await poolConfigContract
                    .connect(poolOwner)
                    .setPoolDefaultGracePeriod(defaultGracePeriodInMonths);

                await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));
                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);
                const oldCR = await creditContract.getCreditRecord(creditHash);
                // +2 because some months have more than 30 days.
                const triggerDefaultDate =
                    oldCR.nextDueDate.toNumber() +
                    (defaultGracePeriodInMonths * CONSTANTS.DAYS_IN_A_MONTH + 2) *
                        CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(triggerDefaultDate);
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .triggerDefault(borrower.getAddress());
                const expectedCR = await creditContract.getCreditRecord(creditHash);
                expect(expectedCR.state).to.equal(CreditState.Defaulted);
                const expectedDD = await creditContract.getDueDetail(creditHash);

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(creditContract, "creditNotInStateForDrawdown");
                const actualCR = await creditContract.getCreditRecord(creditHash);
                checkCreditRecordsMatch(actualCR, expectedCR);
                const actualDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should not allow drawdown when the borrower doesn't meet the first loss cover requirement", async function () {
                await borrowerFirstLossCoverContract
                    .connect(poolOwner)
                    .setCoverProvider(borrower.address, {
                        poolCapCoverageInBps: 5,
                        poolValueCoverageInBps: 500,
                    });

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "insufficientBorrowerFirstLossCover",
                );
            });

            it("Should not allow drawdown before the designated start date", async function () {
                const nextBlockTimestamp = await getFutureBlockTime(2);
                await setNextBlockTimestamp(nextBlockTimestamp);
                const designatedStartDate = moment
                    .utc(nextBlockTimestamp * 1000)
                    .add(5, "days")
                    .startOf("day");

                await poolConfigContract.connect(poolOwner).setCreditApprovalExpiration(1);
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        1,
                        1217,
                        toToken(10_000),
                        designatedStartDate.unix(),
                        true,
                    );

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(creditContract, "firstDrawdownTooSoon");
            });

            it("Should not allow drawdown again if the credit line is non-revolving", async function () {
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        1,
                        1217,
                        toToken(0),
                        0,
                        false,
                    );
                await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "attemptedDrawdownForNonrevolvingLine",
                );
            });

            it("Should not allow drawdown again if the credit limit is exceeded after bill refresh", async function () {
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(10_000),
                        5,
                        1217,
                        toToken(0),
                        0,
                        true,
                    );
                await creditContract.connect(borrower).drawdown(borrower.address, toToken(9_000));

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(1_001)),
                ).to.be.revertedWithCustomError(creditContract, "creditLineExceeded");
            });

            it("Should not allow drawdown if the borrow amount is less than front loading fees after bill refresh", async function () {
                const frontLoadingFeeFlat = toToken(1000);
                const frontLoadingFeeBps = BN.from(0);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, toToken(999)),
                ).to.be.revertedWithCustomError(
                    creditDueManagerContract,
                    "borrowingAmountLessThanPlatformFees",
                );
            });

            it("Should allow the borrower to borrow for the first time", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                const borrowAmount = toToken(50_000);
                const netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditManagerContract.getCreditConfig(creditHash);
                const [yieldDue] = calcYieldDue(cc, borrowAmount, days);

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue);
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                const cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    BN.from(0),
                    0,
                    numOfPeriods - 1,
                    CreditState.GoodStanding,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: yieldDue }));
            });

            it("Should allow the borrower to borrow again in the same period", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                let borrowAmount = toToken(30_000);
                let totalBorrowAmount = borrowAmount;
                let netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditManagerContract.getCreditConfig(creditHash);
                let [yieldDue] = calcYieldDue(cc, borrowAmount, days);
                let totalYieldDue = yieldDue;

                let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue)
                    .to.emit(poolContract, "ProfitDistributed");
                let borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                let cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    BN.from(0),
                    0,
                    numOfPeriods - 1,
                    CreditState.GoodStanding,
                );
                const remainingPeriods = cr.remainingPeriods;
                let dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: yieldDue }));

                // move forward to the middle of the remaining time of the period
                nextTime = nextTime + Math.floor((nextDueDate.toNumber() - nextTime) / 2);
                await setNextBlockTimestamp(nextTime);

                borrowAmount = toToken(10_000);
                totalBorrowAmount = totalBorrowAmount.add(borrowAmount);
                netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);

                startOfDay = getStartOfDay(nextTime);
                days = (await calendarContract.getDaysDiff(startOfDay, nextDueDate)).toNumber();
                [yieldDue] = calcYieldDue(cc, borrowAmount, days);
                totalYieldDue = totalYieldDue.add(yieldDue);

                borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(poolContract, "ProfitDistributed");
                borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    totalBorrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    remainingPeriods,
                    CreditState.GoodStanding,
                );
                dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: totalYieldDue }));
            });

            it("Should allow the borrower to borrow again in the next period", async function () {
                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                let borrowAmount = toToken(25000);
                let totalBorrowAmount = borrowAmount;
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let cr = await creditContract.getCreditRecord(creditHash);
                await creditContract.connect(borrower).makePayment(borrower.address, cr.nextDue);

                const nextTime = cr.nextDueDate.toNumber() + CONSTANTS.SECONDS_IN_A_DAY * 10;
                await setNextBlockTimestamp(nextTime);

                const frontLoadingFeeFlat = toToken(200);
                const frontLoadingFeeBps = BN.from(200);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                let cc = await creditManagerContract.getCreditConfig(creditHash);
                let [yieldDue] = calcYieldDue(cc, borrowAmount, 30);
                let totalYieldDue = yieldDue;
                borrowAmount = toToken(35000);
                totalBorrowAmount = totalBorrowAmount.add(borrowAmount);
                const netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                [yieldDue] = calcYieldDue(cc, borrowAmount, days);
                totalYieldDue = totalYieldDue.add(yieldDue);

                const remainingPeriods = cr.remainingPeriods;
                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, totalYieldDue)
                    .to.emit(poolContract, "ProfitDistributed");
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    totalBorrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    remainingPeriods - 1,
                    CreditState.GoodStanding,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: totalYieldDue }));
            });
        });

        describe("With commitment", function () {
            async function prepareForDrawdown() {
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        numOfPeriods,
                        yieldInBps,
                        toToken(20_000),
                        0,
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(prepareForDrawdown);
            });

            it("Should allow the borrower to borrow if the committed yield is less than the accrued yield", async function () {
                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                const borrowAmount = toToken(30_000);
                const netBorrowAmount = borrowAmount;
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditManagerContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days);

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue);
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                const cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    BN.from(0),
                    0,
                    numOfPeriods - 1,
                    CreditState.GoodStanding,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: yieldDue, committed: committed }),
                );
            });

            it("Should allow the borrower to borrow if the committed yield is greater than the accrued yield", async function () {
                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                const borrowAmount = toToken(10_000);
                const netBorrowAmount = borrowAmount;
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditManagerContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days);

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeOldBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, committed);
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                const poolSafeNewBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);
                expect(poolSafeOldBalance.sub(poolSafeNewBalance)).to.equal(netBorrowAmount);

                const cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    borrowAmount,
                    nextDueDate,
                    committed,
                    committed,
                    BN.from(0),
                    0,
                    numOfPeriods - 1,
                    CreditState.GoodStanding,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: yieldDue, committed: committed }),
                );
            });

            it("Should allow the borrower to borrow if the committed yield is greater than the accrued yield first, but becomes less than accrued yield after drawdown", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                let borrowAmount = toToken(10_000);
                let totalBorrowAmount = borrowAmount;
                let netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                let [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days);
                let totalYieldDue = yieldDue;

                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    borrowAmount,
                    nextDueDate,
                    committed,
                    committed,
                    BN.from(0),
                    0,
                    numOfPeriods - 1,
                    CreditState.GoodStanding,
                );
                const remainingPeriods = cr.remainingPeriods;

                let dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: yieldDue, committed: committed }),
                );

                // move forward to the middle of the remaining time of the period
                nextTime = nextTime + Math.floor((nextDueDate.toNumber() - nextTime) / 2);
                await setNextBlockTimestamp(nextTime);

                borrowAmount = toToken(50_000);
                totalBorrowAmount = totalBorrowAmount.add(borrowAmount);
                netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);

                startOfDay = getStartOfDay(nextTime);
                days = (await calendarContract.getDaysDiff(startOfDay, nextDueDate)).toNumber();
                [yieldDue] = calcYieldDue(cc, borrowAmount, days);
                totalYieldDue = totalYieldDue.add(yieldDue);

                let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(poolContract, "ProfitDistributed");
                let borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    totalBorrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    remainingPeriods,
                    CreditState.GoodStanding,
                );
                dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: totalYieldDue, committed: committed }),
                );
            });

            it("Should allow the borrower to borrow twice if the committed yield is greater than the accrued yield", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                let borrowAmount = toToken(25_000);
                let totalBorrowAmount = borrowAmount;
                let netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                let [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days);
                let totalYieldDue = yieldDue;

                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    borrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    numOfPeriods - 1,
                    CreditState.GoodStanding,
                );
                const remainingPeriods = cr.remainingPeriods;

                let dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: totalYieldDue, committed: committed }),
                );

                // move forward to the middle of the remaining time of the period
                nextTime = nextTime + Math.floor((nextDueDate.toNumber() - nextTime) / 2);
                await setNextBlockTimestamp(nextTime);

                borrowAmount = toToken(10_000);
                totalBorrowAmount = totalBorrowAmount.add(borrowAmount);
                netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);

                startOfDay = getStartOfDay(nextTime);
                days = (await calendarContract.getDaysDiff(startOfDay, nextDueDate)).toNumber();
                [yieldDue] = calcYieldDue(cc, borrowAmount, days);
                totalYieldDue = totalYieldDue.add(yieldDue);

                let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(poolContract, "ProfitDistributed");
                let borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    totalBorrowAmount,
                    nextDueDate,
                    totalYieldDue,
                    totalYieldDue,
                    BN.from(0),
                    0,
                    remainingPeriods,
                    CreditState.GoodStanding,
                );
                dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({ accrued: totalYieldDue, committed: committed }),
                );
            });
        });

        describe("With principalRate", function () {
            const principalRateInBps = 100;

            async function prepareForDrawdown() {
                await poolConfigContract.connect(poolOwner).setFeeStructure({
                    yieldInBps: 0,
                    minPrincipalRateInBps: principalRateInBps,
                    lateFeeBps: 0,
                });

                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        numOfPeriods,
                        yieldInBps,
                        toToken(0),
                        0,
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(prepareForDrawdown);
            });

            it("Should allow the borrower to borrow for the first time", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                const borrowAmount = toToken(50_000);
                const netBorrowAmount = borrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                let nextTime = await getFutureBlockTime(3);
                await setNextBlockTimestamp(nextTime);

                let startOfDay = getStartOfDay(nextTime);
                let nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                let days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                let cc = await creditManagerContract.getCreditConfig(creditHash);
                const [yieldDue] = calcYieldDue(cc, borrowAmount, days);
                const principalDue = calcPrincipalDueForPartialPeriod(
                    borrowAmount,
                    principalRateInBps,
                    days,
                    30,
                );
                const totalDue = yieldDue.add(principalDue);

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                await expect(
                    creditContract.connect(borrower).drawdown(borrower.address, borrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, borrowAmount, netBorrowAmount)
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, totalDue)
                    .to.emit(poolContract, "ProfitDistributed");
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                const cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    borrowAmount.sub(principalDue),
                    nextDueDate,
                    totalDue,
                    yieldDue,
                    BN.from(0),
                    0,
                    numOfPeriods - 1,
                    CreditState.GoodStanding,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(dueDetail, genDueDetail({ accrued: yieldDue }));
            });

            it("Should allow the borrower to borrow again in the same full period", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                const firstBorrowAmount = toToken(50_000);
                const nextBlockTimestamp = await getFutureBlockTime(3);
                // Push the first drawdown date to the start of next period, which is the 1st of
                // a month, so that we can easily ensure that the first and second drawdown dates
                // are in the same period.
                const firstDrawdownDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextBlockTimestamp,
                );
                await setNextBlockTimestamp(firstDrawdownDate);

                await creditContract
                    .connect(borrower)
                    .drawdown(borrower.address, firstBorrowAmount);

                const secondBorrowAmount = toToken(50_000);
                const netBorrowAmount = secondBorrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                const secondDrawdownDate = firstDrawdownDate.add(CONSTANTS.SECONDS_IN_A_DAY * 2);
                await setNextBlockTimestamp(secondDrawdownDate);

                const startOfDay = getStartOfDay(secondDrawdownDate.toNumber());
                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    secondDrawdownDate,
                );
                const days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const [additionalYieldDue] = calcYieldDue(cc, secondBorrowAmount, days);
                expect(additionalYieldDue).to.be.gt(0);
                const additionalPrincipalDue = calcPrincipalDueForPartialPeriod(
                    secondBorrowAmount,
                    principalRateInBps,
                    days,
                    CONSTANTS.DAYS_IN_A_MONTH,
                );
                expect(additionalPrincipalDue).to.be.gt(0);
                const additionalNextDue = additionalYieldDue.add(additionalPrincipalDue);

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                const oldCR = await creditContract.getCreditRecord(creditHash);
                const oldDD = await creditContract.getDueDetail(creditHash);
                await expect(
                    creditContract
                        .connect(borrower)
                        .drawdown(borrower.address, secondBorrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, secondBorrowAmount, netBorrowAmount)
                    .to.emit(poolContract, "ProfitDistributed");
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    ...oldCR,
                    ...{
                        unbilledPrincipal: oldCR.unbilledPrincipal
                            .add(secondBorrowAmount)
                            .sub(additionalPrincipalDue),
                        nextDue: oldCR.nextDue.add(additionalNextDue),
                        yieldDue: oldCR.yieldDue.add(additionalYieldDue),
                    },
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = {
                    ...oldDD,
                    ...{
                        accrued: oldDD.accrued.add(additionalYieldDue),
                    },
                };
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should allow the borrower to borrow again in the same partial period", async function () {
                const frontLoadingFeeFlat = toToken(100);
                const frontLoadingFeeBps = BN.from(100);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat: frontLoadingFeeFlat,
                    frontLoadingFeeBps: frontLoadingFeeBps,
                });

                const creditHash = await borrowerLevelCreditHash(creditContract, borrower);

                const firstBorrowAmount = toToken(50_000);
                const nextBlockTimestamp = await getFutureBlockTime(3);
                const firstDrawdownDate = (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        nextBlockTimestamp,
                    )
                ).add(CONSTANTS.SECONDS_IN_A_DAY * 2);
                await setNextBlockTimestamp(firstDrawdownDate);

                await creditContract
                    .connect(borrower)
                    .drawdown(borrower.address, firstBorrowAmount);

                const secondBorrowAmount = toToken(50_000);
                const netBorrowAmount = secondBorrowAmount
                    .mul(CONSTANTS.BP_FACTOR.sub(frontLoadingFeeBps))
                    .div(CONSTANTS.BP_FACTOR)
                    .sub(frontLoadingFeeFlat);
                const secondDrawdownDate = firstDrawdownDate.add(CONSTANTS.SECONDS_IN_A_DAY * 2);
                await setNextBlockTimestamp(secondDrawdownDate);

                const startOfDay = getStartOfDay(secondDrawdownDate.toNumber());
                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    secondDrawdownDate,
                );
                const days = (
                    await calendarContract.getDaysDiff(startOfDay, nextDueDate)
                ).toNumber();
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const [additionalYieldDue] = calcYieldDue(cc, secondBorrowAmount, days);
                expect(additionalYieldDue).to.be.gt(0);
                const additionalPrincipalDue = calcPrincipalDueForPartialPeriod(
                    secondBorrowAmount,
                    principalRateInBps,
                    days,
                    CONSTANTS.DAYS_IN_A_MONTH,
                );
                expect(additionalPrincipalDue).to.be.gt(0);
                const additionalNextDue = additionalYieldDue.add(additionalPrincipalDue);

                const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
                const oldCR = await creditContract.getCreditRecord(creditHash);
                const oldDD = await creditContract.getDueDetail(creditHash);
                await expect(
                    creditContract
                        .connect(borrower)
                        .drawdown(borrower.address, secondBorrowAmount),
                )
                    .to.emit(creditContract, "DrawdownMade")
                    .withArgs(borrower.address, secondBorrowAmount, netBorrowAmount)
                    .to.emit(poolContract, "ProfitDistributed");
                const borrowerNewBalance = await mockTokenContract.balanceOf(borrower.address);
                expect(borrowerNewBalance.sub(borrowerOldBalance)).to.equal(netBorrowAmount);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    ...oldCR,
                    ...{
                        unbilledPrincipal: oldCR.unbilledPrincipal
                            .add(secondBorrowAmount)
                            .sub(additionalPrincipalDue),
                        nextDue: oldCR.nextDue.add(additionalNextDue),
                        yieldDue: oldCR.yieldDue.add(additionalYieldDue),
                    },
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = {
                    ...oldDD,
                    ...{
                        accrued: oldDD.accrued.add(additionalYieldDue),
                    },
                };
                checkDueDetailsMatch(actualDD, expectedDD);
            });
        });
    });

    describe("getNextBillRefreshDate and refreshCredit", function () {
        const yieldInBps = 1217;
        const numOfPeriods = 3,
            latePaymentGracePeriodInDays = 5;
        let committedAmount: BN, borrowAmount: BN;
        let creditHash: string;

        async function prepareForTests() {
            await poolConfigContract
                .connect(poolOwner)
                .setLatePaymentGracePeriodInDays(latePaymentGracePeriodInDays);

            committedAmount = toToken(10_000);
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    numOfPeriods,
                    yieldInBps,
                    committedAmount,
                    0,
                    true,
                );
        }

        describe("Negative Tests", function () {
            describe("If drawdown has not happened yet", function () {
                async function prepare() {
                    creditHash = ethers.utils.keccak256(
                        ethers.utils.defaultAbiCoder.encode(
                            ["address", "address"],
                            [creditContract.address, borrower.address],
                        ),
                    );
                    await prepareForTests();
                }

                beforeEach(async function () {
                    await loadFixture(prepare);
                });

                it("Should not update anything", async function () {
                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    await creditManagerContract.refreshCredit(borrower.address);
                    checkCreditRecordsMatch(
                        await creditContract.getCreditRecord(creditHash),
                        oldCR,
                    );
                    checkDueDetailsMatch(await creditContract.getDueDetail(creditHash), oldDD);
                });

                it("Should not update anything if the credit is closed after approval", async function () {
                    await creditManagerContract
                        .connect(eaServiceAccount)
                        .closeCredit(borrower.getAddress());

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    await creditManagerContract.refreshCredit(borrower.address);
                    checkCreditRecordsMatch(
                        await creditContract.getCreditRecord(creditHash),
                        oldCR,
                    );
                    checkDueDetailsMatch(await creditContract.getDueDetail(creditHash), oldDD);
                });
            });

            describe("If drawdown has happened", function () {
                async function prepare() {
                    borrowAmount = toToken(20_000);
                    creditHash = ethers.utils.keccak256(
                        ethers.utils.defaultAbiCoder.encode(
                            ["address", "address"],
                            [creditContract.address, borrower.address],
                        ),
                    );
                    await prepareForTests();
                    await creditContract
                        .connect(borrower)
                        .drawdown(borrower.address, borrowAmount);
                }

                beforeEach(async function () {
                    await loadFixture(prepare);
                });

                it("Should not update anything if the bill is in the current billing cycle and is in good standing", async function () {
                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    await creditManagerContract.refreshCredit(borrower.address);
                    checkCreditRecordsMatch(
                        await creditContract.getCreditRecord(creditHash),
                        oldCR,
                    );
                    checkDueDetailsMatch(await creditContract.getDueDetail(creditHash), oldDD);
                });

                it("Should not update anything if the bill is in good standing and within the late payment grace period", async function () {
                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const refreshDate = oldCR.nextDueDate.toNumber() + 3600;
                    await setNextBlockTimestamp(refreshDate);

                    const oldDD = await creditContract.getDueDetail(creditHash);
                    await creditManagerContract.refreshCredit(borrower.address);
                    checkCreditRecordsMatch(
                        await creditContract.getCreditRecord(creditHash),
                        oldCR,
                    );
                    checkDueDetailsMatch(await creditContract.getDueDetail(creditHash), oldDD);
                });

                it("Should not update anything if the credit state is Defaulted", async function () {
                    const defaultGracePeriodInMonths = 1;
                    await poolConfigContract
                        .connect(poolOwner)
                        .setPoolDefaultGracePeriod(defaultGracePeriodInMonths);

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    // +2 because some months have more than 30 days.
                    const triggerDefaultDate =
                        oldCR.nextDueDate.toNumber() +
                        (defaultGracePeriodInMonths * CONSTANTS.DAYS_IN_A_MONTH + 2) *
                            CONSTANTS.SECONDS_IN_A_DAY;
                    await setNextBlockTimestamp(triggerDefaultDate);
                    await creditManagerContract
                        .connect(eaServiceAccount)
                        .triggerDefault(borrower.getAddress());
                    const expectedCR = await creditContract.getCreditRecord(creditHash);
                    expect(expectedCR.state).to.equal(CreditState.Defaulted);
                    const expectedDD = await creditContract.getDueDetail(creditHash);

                    await creditManagerContract.refreshCredit(borrower.getAddress());
                    const actualCR = await creditContract.getCreditRecord(creditHash);
                    checkCreditRecordsMatch(actualCR, expectedCR);
                    const actualDD = await creditContract.getDueDetail(creditHash);
                    checkDueDetailsMatch(actualDD, expectedDD);
                });
            });
        });

        describe("Without settings", function () {
            async function prepareForTestsWithoutSettings() {
                await prepareForTests();

                creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            }

            beforeEach(async function () {
                await loadFixture(prepareForTestsWithoutSettings);
            });

            it("Should update correctly when the credit is delayed by 1 period", async function () {
                borrowAmount = toToken(20_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const cr = await creditContract.getCreditRecord(creditHash);
                const settings = await poolConfigContract.getPoolSettings();
                const latePaymentDeadline =
                    cr.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY;
                const nextTime = latePaymentDeadline + 100;
                await setNextBlockTimestamp(nextTime);

                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                const days = (
                    await calendarContract.getDaysDiff(cr.nextDueDate, nextDueDate)
                ).toNumber();
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days);
                const totalPastDue = cr.nextDue;

                const remainingPeriods = cr.remainingPeriods;
                const nextBillRefreshDate = await creditContract.getNextBillRefreshDate(
                    borrower.getAddress(),
                );
                expect(nextBillRefreshDate).to.equal(latePaymentDeadline);
                await expect(creditManagerContract.refreshCredit(borrower.getAddress()))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue);

                const tomorrow = await calendarContract.getStartOfTomorrow();
                const actualCR = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    actualCR,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    totalPastDue,
                    1,
                    remainingPeriods - 1,
                    CreditState.Delayed,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({
                        lateFeeUpdatedDate: tomorrow,
                        accrued: yieldDue,
                        committed: committed,
                        yieldPastDue: totalPastDue,
                    }),
                );
            });

            it("Should update correctly again in the same period if the credit state is Delayed", async function () {
                borrowAmount = toToken(20_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const cr = await creditContract.getCreditRecord(creditHash);
                const settings = await poolConfigContract.getPoolSettings();
                let nextTime =
                    cr.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextTime);
                await creditManagerContract.refreshCredit(borrower.address);

                const days = CONSTANTS.SECONDS_IN_A_DAY;
                nextTime = nextTime + days;
                await setNextBlockTimestamp(nextTime);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                let dueDetail = await creditContract.getDueDetail(creditHash);
                const nextBillRefreshDate = await creditContract.getNextBillRefreshDate(
                    borrower.getAddress(),
                );
                expect(nextBillRefreshDate).to.equal(actualCR.nextDueDate);
                await creditManagerContract.refreshCredit(borrower.address);
                checkCreditRecordsMatch(
                    await creditContract.getCreditRecord(creditHash),
                    actualCR,
                );
                dueDetail = {
                    ...dueDetail,
                    ...{ lateFeeUpdatedDate: dueDetail.lateFeeUpdatedDate.add(days) },
                };
                checkDueDetailsMatch(await creditContract.getDueDetail(creditHash), dueDetail);
            });

            it("Should update correctly again in the next period if the credit state is Delayed", async function () {
                borrowAmount = toToken(20_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let cr = await creditContract.getCreditRecord(creditHash);
                const settings = await poolConfigContract.getPoolSettings();
                let nextTime =
                    cr.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextTime);

                let totalPastDue = cr.nextDue;
                await creditManagerContract.refreshCredit(borrower.address);

                cr = await creditContract.getCreditRecord(creditHash);
                nextTime = cr.nextDueDate.toNumber() + 100;
                await setNextBlockTimestamp(nextTime);

                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                const days = (
                    await calendarContract.getDaysDiff(cr.nextDueDate, nextDueDate)
                ).toNumber();
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days);

                totalPastDue = totalPastDue.add(cr.nextDue);
                const nextBillRefreshDate = await creditContract.getNextBillRefreshDate(
                    borrower.getAddress(),
                );
                expect(nextBillRefreshDate).to.equal(cr.nextDueDate);
                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldDue);

                const remainingPeriods = cr.remainingPeriods;
                const missingPeriods = cr.missedPeriods;
                cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    borrowAmount,
                    nextDueDate,
                    yieldDue,
                    yieldDue,
                    totalPastDue,
                    missingPeriods + 1,
                    remainingPeriods - 1,
                    CreditState.Delayed,
                );
            });

            it("Should update immediately in the beginning of the next period if all dues are paid off in the current period", async function () {
                borrowAmount = toToken(20_000);
                // Drawdown and make payment for all dues in the first period.
                const drawdownDate = (await calendarContract.getStartOfNextMonth()).toNumber();
                await setNextBlockTimestamp(drawdownDate);
                await creditContract
                    .connect(borrower)
                    .drawdown(borrower.getAddress(), borrowAmount);
                let oldCR = await creditContract.getCreditRecord(creditHash);
                const makePaymentDate = drawdownDate + 5 * CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(makePaymentDate);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), oldCR.nextDue);

                oldCR = await creditContract.getCreditRecord(creditHash);
                // The refresh date is within the late payment grace period of the current bill.
                const refreshDate = oldCR.nextDueDate.toNumber() + CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(refreshDate);

                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    refreshDate,
                );
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const startDateOfPeriod = await calendarContract.getStartDateOfPeriod(
                    cc.periodDuration,
                    refreshDate,
                );
                const daysNextDue = (
                    await calendarContract.getDaysDiff(startDateOfPeriod, nextDueDate)
                ).toNumber();
                const [yieldNextDue, committed] = calcYieldDue(
                    cc,
                    oldCR.unbilledPrincipal,
                    daysNextDue,
                );

                const nextBillRefreshDate = await creditContract.getNextBillRefreshDate(
                    borrower.getAddress(),
                );
                expect(nextBillRefreshDate).to.equal(oldCR.nextDueDate);
                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, yieldNextDue);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    unbilledPrincipal: oldCR.unbilledPrincipal,
                    nextDueDate: nextDueDate,
                    nextDue: yieldNextDue,
                    yieldDue: yieldNextDue,
                    totalPastDue: 0,
                    missedPeriods: 0,
                    remainingPeriods: oldCR.remainingPeriods - 1,
                    state: CreditState.GoodStanding,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = genDueDetail({
                    accrued: yieldNextDue,
                    committed: committed,
                    paid: 0,
                });
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should update correctly for the first time in the last period", async function () {
                borrowAmount = toToken(5_000);
                const drawdownDate = await getFutureBlockTime(2);
                await setNextBlockTimestamp(drawdownDate);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const maturityDate = await calendarContract.getMaturityDate(
                    cc.periodDuration,
                    cc.numOfPeriods,
                    drawdownDate,
                );
                const nextTime = maturityDate.toNumber() - 600;
                await setNextBlockTimestamp(nextTime);

                const startDateOfLastPeriod = await calendarContract.getStartDateOfPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                const days = (
                    await calendarContract.getDaysDiff(startDateOfLastPeriod, maturityDate)
                ).toNumber();
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days);

                let cr = await creditContract.getCreditRecord(creditHash);
                let totalPastDue = cr.nextDue;
                totalPastDue = totalPastDue.add(
                    calcYieldDue(
                        cc,
                        committedAmount,
                        (
                            await calendarContract.getDaysDiff(
                                cr.nextDueDate,
                                startDateOfLastPeriod,
                            )
                        ).toNumber(),
                    )[0],
                );
                const remainingPeriods = cr.remainingPeriods;
                const latePaymentDeadline =
                    cr.nextDueDate.toNumber() +
                    latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY;

                const nextBillRefreshDate = await creditContract.getNextBillRefreshDate(
                    borrower.getAddress(),
                );
                expect(nextBillRefreshDate).to.equal(latePaymentDeadline);
                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, maturityDate, committed);

                cr = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    cr,
                    borrowAmount,
                    maturityDate,
                    committed,
                    committed,
                    totalPastDue,
                    remainingPeriods,
                    0,
                    CreditState.Delayed,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({
                        lateFeeUpdatedDate: maturityDate,
                        accrued: yieldDue,
                        committed: committed,
                        yieldPastDue: totalPastDue,
                    }),
                );
            });

            it("Should update correctly if the bill is refreshed multiple times after maturity date", async function () {
                borrowAmount = toToken(20_000);
                const drawdownDate = await getFutureBlockTime(2);
                await setNextBlockTimestamp(drawdownDate);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const maturityDate = await calendarContract.getMaturityDate(
                    cc.periodDuration,
                    cc.numOfPeriods,
                    drawdownDate,
                );
                const firstRefreshDate = maturityDate.toNumber() + 600;
                await setNextBlockTimestamp(firstRefreshDate);

                const oldCR = await creditContract.getCreditRecord(creditHash);
                const expectedFirstDueDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    firstRefreshDate,
                );
                const latePaymentDeadline =
                    oldCR.nextDueDate.toNumber() +
                    latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY;

                const nextBillRefreshDate = await creditContract.getNextBillRefreshDate(
                    borrower.getAddress(),
                );
                expect(nextBillRefreshDate).to.equal(latePaymentDeadline);
                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, expectedFirstDueDate, 0);

                const actualFirstCR = await creditContract.getCreditRecord(creditHash);
                const daysPassed = await calendarContract.getDaysDiff(
                    oldCR.nextDueDate,
                    maturityDate,
                );
                const expectedYieldPastDue = calcYield(
                    borrowAmount,
                    yieldInBps,
                    daysPassed.toNumber(),
                );
                const expectedFirstLateFeeUpdatedDate =
                    await calendarContract.getStartOfNextDay(firstRefreshDate);
                const expectedFirstCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedFirstDueDate,
                    nextDue: BN.from(0),
                    yieldDue: BN.from(0),
                    totalPastDue: borrowAmount.add(oldCR.yieldDue).add(expectedYieldPastDue),
                    missedPeriods: cc.numOfPeriods,
                    remainingPeriods: 0,
                    state: CreditState.Delayed,
                };
                checkCreditRecordsMatch(actualFirstCR, expectedFirstCR);

                const actualFirstDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    actualFirstDD,
                    genDueDetail({
                        lateFeeUpdatedDate: expectedFirstLateFeeUpdatedDate,
                        principalPastDue: borrowAmount,
                        yieldPastDue: oldCR.yieldDue.add(expectedYieldPastDue),
                    }),
                );

                const secondRefreshDate =
                    (
                        await calendarContract.getStartDateOfNextPeriod(
                            cc.periodDuration,
                            firstRefreshDate,
                        )
                    ).toNumber() + 600;
                await setNextBlockTimestamp(secondRefreshDate);
                const expectedSecondDueDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    secondRefreshDate,
                );
                expect(secondRefreshDate).to.not.equal(firstRefreshDate);

                const secondNextBillRefreshDate = await creditContract.getNextBillRefreshDate(
                    borrower.getAddress(),
                );
                expect(secondNextBillRefreshDate).to.equal(actualFirstCR.nextDueDate);
                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, expectedSecondDueDate, 0);

                const actualSecondCR = await creditContract.getCreditRecord(creditHash);
                const expectedSecondLateFeeUpdatedDate =
                    await calendarContract.getStartOfNextDay(secondRefreshDate);
                const expectedSecondCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedSecondDueDate,
                    nextDue: BN.from(0),
                    yieldDue: BN.from(0),
                    // Add the incremental late fee to past due.
                    totalPastDue: actualFirstCR.totalPastDue,
                    missedPeriods: actualFirstCR.missedPeriods + 1,
                    remainingPeriods: 0,
                    state: CreditState.Delayed,
                };
                checkCreditRecordsMatch(actualSecondCR, expectedSecondCR);

                const actualSecondDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    actualSecondDD,
                    genDueDetail({
                        lateFeeUpdatedDate: expectedSecondLateFeeUpdatedDate,
                        principalPastDue: borrowAmount,
                        yieldPastDue: actualFirstDD.yieldPastDue,
                    }),
                );
            });

            it("Should update correctly once in the last period, and again post-maturity", async function () {
                borrowAmount = toToken(5_000);
                const drawdownDate = await getFutureBlockTime(2);
                await setNextBlockTimestamp(drawdownDate);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const cc = await creditManagerContract.getCreditConfig(creditHash);
                // First refresh is performed before maturity.
                const maturityDate = await calendarContract.getMaturityDate(
                    cc.periodDuration,
                    cc.numOfPeriods,
                    drawdownDate,
                );
                const firstRefreshDate = maturityDate.toNumber() - 600;
                await setNextBlockTimestamp(firstRefreshDate);
                await creditManagerContract.refreshCredit(borrower.address);

                // Second refresh is performed post-maturity.
                const secondRefreshDate = maturityDate.toNumber() + 600;
                await setNextBlockTimestamp(secondRefreshDate);

                const oldCR = await creditContract.getCreditRecord(creditHash);
                const oldDD = await creditContract.getDueDetail(creditHash);
                const expectedNextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    oldCR.nextDueDate,
                );

                const nextBillRefreshDate = await creditContract.getNextBillRefreshDate(
                    borrower.getAddress(),
                );
                expect(nextBillRefreshDate).to.equal(oldCR.nextDueDate);
                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, expectedNextDueDate, 0);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedNextDueDate,
                    nextDue: BN.from(0),
                    yieldDue: BN.from(0),
                    totalPastDue: oldCR.totalPastDue
                        .add(oldCR.nextDue)
                        .add(oldCR.unbilledPrincipal),
                    missedPeriods: oldCR.missedPeriods + 1,
                    remainingPeriods: 0,
                    state: CreditState.Delayed,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    actualDD,
                    genDueDetail({
                        lateFeeUpdatedDate: await calendarContract.getStartOfTomorrow(),
                        principalPastDue: borrowAmount,
                        yieldPastDue: oldDD.yieldPastDue.add(oldCR.yieldDue),
                    }),
                );
            });
        });

        describe("With Settings(principalRate, lateFeeInBps)", function () {
            const principalRate = 100;
            const lateFeeBps = 2400;

            async function prepareForTestsWithSettings() {
                await poolConfigContract.connect(poolOwner).setFeeStructure({
                    yieldInBps: yieldInBps,
                    minPrincipalRateInBps: principalRate,
                    lateFeeBps: lateFeeBps,
                });
                await prepareForTests();

                creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            }

            beforeEach(async function () {
                await loadFixture(prepareForTestsWithSettings);
            });

            it("Should update correctly when the credit is delayed by 1 period", async function () {
                borrowAmount = toToken(5_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const cr = await creditContract.getCreditRecord(creditHash);
                const settings = await poolConfigContract.getPoolSettings();
                const nextTime =
                    cr.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextTime);

                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                const days = (
                    await calendarContract.getDaysDiff(cr.nextDueDate, nextDueDate)
                ).toNumber();
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days);
                const principalDue = calcPrincipalDueForFullPeriods(
                    cr.unbilledPrincipal,
                    principalRate,
                    1,
                );
                const nextDue = committed.add(principalDue);

                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, nextDue);

                const tomorrow = await calendarContract.getStartOfTomorrow();
                const lateFee = calcYield(
                    committedAmount,
                    lateFeeBps,
                    (await calendarContract.getDaysDiff(cr.nextDueDate, tomorrow)).toNumber(),
                );

                const newCreditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    newCreditRecord,
                    cr.unbilledPrincipal.sub(principalDue),
                    nextDueDate,
                    nextDue,
                    committed,
                    cr.nextDue.add(lateFee),
                    1,
                    cr.remainingPeriods - 1,
                    CreditState.Delayed,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({
                        lateFeeUpdatedDate: tomorrow,
                        lateFee: lateFee,
                        accrued: yieldDue,
                        committed: committed,
                        yieldPastDue: cr.yieldDue,
                        principalPastDue: cr.nextDue.sub(cr.yieldDue),
                    }),
                );
            });

            it("Should update immediately in the beginning of the next period if all dues are paid off in the current period", async function () {
                borrowAmount = toToken(20_000);
                // Drawdown and make payment for all dues in the first period.
                const drawdownDate = (await calendarContract.getStartOfNextMonth()).toNumber();
                await setNextBlockTimestamp(drawdownDate);
                await creditContract
                    .connect(borrower)
                    .drawdown(borrower.getAddress(), borrowAmount);
                let oldCR = await creditContract.getCreditRecord(creditHash);
                const makePaymentDate = drawdownDate + 5 * CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(makePaymentDate);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), oldCR.nextDue);

                oldCR = await creditContract.getCreditRecord(creditHash);
                // The refresh date is within the late payment grace period of the current bill.
                const refreshDate = oldCR.nextDueDate.toNumber() + CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(refreshDate);

                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    refreshDate,
                );
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const startDateOfPeriod = await calendarContract.getStartDateOfPeriod(
                    cc.periodDuration,
                    refreshDate,
                );
                const daysNextDue = (
                    await calendarContract.getDaysDiff(startDateOfPeriod, nextDueDate)
                ).toNumber();
                const [yieldNextDue, committed] = calcYieldDue(
                    cc,
                    oldCR.unbilledPrincipal,
                    daysNextDue,
                );
                const principalNextDue = calcPrincipalDueForFullPeriods(
                    oldCR.unbilledPrincipal,
                    principalRate,
                    1,
                );
                const nextDue = yieldNextDue.add(principalNextDue);

                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, nextDue);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    unbilledPrincipal: oldCR.unbilledPrincipal.sub(principalNextDue),
                    nextDueDate: nextDueDate,
                    nextDue: nextDue,
                    yieldDue: yieldNextDue,
                    totalPastDue: 0,
                    missedPeriods: 0,
                    remainingPeriods: oldCR.remainingPeriods - 1,
                    state: CreditState.GoodStanding,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = genDueDetail({
                    accrued: yieldNextDue,
                    committed: committed,
                    paid: 0,
                });
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should update correctly when all dues are paid off, but then delayed", async function () {
                borrowAmount = toToken(20_000);
                // Drawdown and make payment for all dues in the first period.
                const drawdownDate = (await calendarContract.getStartOfNextMonth()).toNumber();
                await setNextBlockTimestamp(drawdownDate);
                await creditContract
                    .connect(borrower)
                    .drawdown(await borrower.getAddress(), borrowAmount);
                let oldCR = await creditContract.getCreditRecord(creditHash);
                const makePaymentDate = drawdownDate + 5 * CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(makePaymentDate);
                await creditContract
                    .connect(borrower)
                    .makePayment(await borrower.getAddress(), oldCR.nextDue);

                oldCR = await creditContract.getCreditRecord(creditHash);
                const refreshDate = moment
                    .utc(oldCR.nextDueDate.toNumber() * 1000)
                    .add(1, "month")
                    .add(2, "days")
                    .unix();
                await setNextBlockTimestamp(refreshDate);

                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    refreshDate,
                );
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const startDateOfPeriod = await calendarContract.getStartDateOfPeriod(
                    cc.periodDuration,
                    refreshDate,
                );
                const daysOverdue = (
                    await calendarContract.getDaysDiff(oldCR.nextDueDate, startDateOfPeriod)
                ).toNumber();
                const daysNextDue = (
                    await calendarContract.getDaysDiff(startDateOfPeriod, nextDueDate)
                ).toNumber();
                const [yieldNextDue, committed] = calcYieldDue(
                    cc,
                    oldCR.unbilledPrincipal,
                    daysNextDue,
                );
                const [yieldPastDue] = calcYieldDue(cc, oldCR.unbilledPrincipal, daysOverdue);
                const principalPastDue = calcPrincipalDueForFullPeriods(
                    oldCR.unbilledPrincipal,
                    principalRate,
                    1,
                );
                const principalNextDue = calcPrincipalDueForFullPeriods(
                    oldCR.unbilledPrincipal.sub(principalPastDue),
                    principalRate,
                    1,
                );
                const nextDue = yieldNextDue.add(principalNextDue);

                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, nextDue);

                const tomorrow = await calendarContract.getStartOfTomorrow();
                const previousBillDueDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    oldCR.nextDueDate,
                );
                const lateFee = calcYield(
                    oldCR.unbilledPrincipal.add(oldCR.nextDue.sub(oldCR.yieldDue)),
                    lateFeeBps,
                    (await calendarContract.getDaysDiff(previousBillDueDate, tomorrow)).toNumber(),
                );

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    unbilledPrincipal: oldCR.unbilledPrincipal
                        .sub(principalNextDue)
                        .sub(principalPastDue),
                    nextDueDate: nextDueDate,
                    nextDue: nextDue,
                    yieldDue: yieldNextDue,
                    totalPastDue: yieldPastDue.add(principalPastDue).add(lateFee),
                    missedPeriods: 1,
                    remainingPeriods: oldCR.remainingPeriods - 2,
                    state: CreditState.Delayed,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = {
                    lateFeeUpdatedDate: tomorrow,
                    lateFee: lateFee,
                    yieldPastDue: yieldPastDue,
                    principalPastDue: principalPastDue,
                    accrued: yieldNextDue,
                    committed: committed,
                    paid: 0,
                };
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should update correctly if the bill is compconstely paid off, but then delayed due to having outstanding commitment", async function () {
                borrowAmount = toToken(20_000);
                // Drawdown and make payment for all dues in the first period.
                const drawdownDate = (await calendarContract.getStartOfNextMonth()).toNumber();
                await setNextBlockTimestamp(drawdownDate);
                await creditContract
                    .connect(borrower)
                    .drawdown(await borrower.getAddress(), borrowAmount);
                let oldCR = await creditContract.getCreditRecord(creditHash);
                const makePaymentDate = drawdownDate + 5 * CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(makePaymentDate);
                await creditContract
                    .connect(borrower)
                    .makePayment(
                        await borrower.getAddress(),
                        oldCR.nextDue.add(oldCR.unbilledPrincipal),
                    );

                oldCR = await creditContract.getCreditRecord(creditHash);
                const refreshDate = moment
                    .utc(oldCR.nextDueDate.toNumber() * 1000)
                    .add(1, "month")
                    .add(2, "days")
                    .unix();
                await setNextBlockTimestamp(refreshDate);

                const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    PayPeriodDuration.Monthly,
                    refreshDate,
                );
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const startDateOfPeriod = await calendarContract.getStartDateOfPeriod(
                    cc.periodDuration,
                    refreshDate,
                );
                const daysOverdue = (
                    await calendarContract.getDaysDiff(oldCR.nextDueDate, startDateOfPeriod)
                ).toNumber();
                const daysNextDue = (
                    await calendarContract.getDaysDiff(startDateOfPeriod, nextDueDate)
                ).toNumber();
                const [, committedNextDue] = calcYieldDue(
                    cc,
                    oldCR.unbilledPrincipal,
                    daysNextDue,
                );
                const [, committedPastDue] = calcYieldDue(
                    cc,
                    oldCR.unbilledPrincipal,
                    daysOverdue,
                );

                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, nextDueDate, committedNextDue);

                const tomorrow = await calendarContract.getStartOfTomorrow();
                const lateFee = calcYield(
                    cc.committedAmount,
                    lateFeeBps,
                    (await calendarContract.getDaysDiff(startDateOfPeriod, tomorrow)).toNumber(),
                );
                expect(lateFee).to.be.gt(0);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    unbilledPrincipal: 0,
                    nextDueDate: nextDueDate,
                    nextDue: committedNextDue,
                    yieldDue: committedNextDue,
                    totalPastDue: committedPastDue.add(lateFee),
                    missedPeriods: 1,
                    remainingPeriods: oldCR.remainingPeriods - 2,
                    state: CreditState.Delayed,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = {
                    lateFeeUpdatedDate: tomorrow,
                    lateFee: lateFee,
                    yieldPastDue: committedPastDue,
                    principalPastDue: 0,
                    accrued: 0,
                    committed: committedNextDue,
                    paid: 0,
                };
                checkDueDetailsMatch(actualDD, expectedDD);
            });

            it("Should update correctly for the first time in the last period", async function () {
                borrowAmount = toToken(20_000);
                const drawdownDate = await getFutureBlockTime(2);
                await setNextBlockTimestamp(drawdownDate);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const maturityDate = await calendarContract.getMaturityDate(
                    cc.periodDuration,
                    cc.numOfPeriods,
                    drawdownDate,
                );
                const nextTime = maturityDate.toNumber() - 600;
                await setNextBlockTimestamp(nextTime);

                const startDateOfLastPeriod = await calendarContract.getStartDateOfPeriod(
                    PayPeriodDuration.Monthly,
                    nextTime,
                );
                const days = (
                    await calendarContract.getDaysDiff(startDateOfLastPeriod, maturityDate)
                ).toNumber();
                const [yieldDue, committed] = calcYieldDue(cc, borrowAmount, days);
                const cr = await creditContract.getCreditRecord(creditHash);
                let principalPastDue = calcPrincipalDueForFullPeriods(
                    cr.unbilledPrincipal,
                    principalRate,
                    cr.remainingPeriods - 1,
                );
                const yieldPastDue = calcYield(
                    borrowAmount,
                    yieldInBps,
                    (
                        await calendarContract.getDaysDiff(cr.nextDueDate, startDateOfLastPeriod)
                    ).toNumber(),
                ).add(cr.yieldDue);
                const unbilledPrincipal = cr.unbilledPrincipal.sub(principalPastDue);
                const principalDue = calcPrincipalDueForPartialPeriod(
                    unbilledPrincipal,
                    principalRate,
                    days,
                    CONSTANTS.DAYS_IN_A_MONTH,
                );
                principalPastDue = principalPastDue.add(cr.nextDue.sub(cr.yieldDue));
                const nextDue = yieldDue.add(principalDue);

                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, maturityDate, nextDue);

                const tomorrow = await calendarContract.getStartOfTomorrow();
                const lateFee = calcYield(
                    borrowAmount,
                    lateFeeBps,
                    (await calendarContract.getDaysDiff(cr.nextDueDate, tomorrow)).toNumber(),
                );

                const newCreditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    newCreditRecord,
                    unbilledPrincipal.sub(principalDue),
                    maturityDate,
                    nextDue,
                    yieldDue,
                    yieldPastDue.add(principalPastDue).add(lateFee),
                    cr.remainingPeriods,
                    0,
                    CreditState.Delayed,
                );

                const dueDetail = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    dueDetail,
                    genDueDetail({
                        lateFeeUpdatedDate: tomorrow,
                        lateFee: lateFee,
                        accrued: yieldDue,
                        committed: committed,
                        yieldPastDue: yieldPastDue,
                        principalPastDue: principalPastDue,
                    }),
                );
            });

            it("Should update correctly again in the next period if the credit state is Delayed", async function () {
                borrowAmount = toToken(20_000);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                let oldCR = await creditContract.getCreditRecord(creditHash);
                const settings = await poolConfigContract.getPoolSettings();
                // First refresh happens after the late payment grace period so that the bill becomes late.
                const firstRefreshDate =
                    oldCR.nextDueDate.toNumber() +
                    settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(firstRefreshDate);
                await creditManagerContract.refreshCredit(borrower.address);

                oldCR = await creditContract.getCreditRecord(creditHash);
                const oldDD = await creditContract.getDueDetail(creditHash);
                // Second refresh happens in another period afterward.
                const secondRefreshDate = oldCR.nextDueDate.toNumber() + 100;
                await setNextBlockTimestamp(secondRefreshDate);

                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const expectedNextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    secondRefreshDate,
                );
                const daysPassed = (
                    await calendarContract.getDaysDiff(oldCR.nextDueDate, expectedNextDueDate)
                ).toNumber();
                const [accruedYieldDue, committedYieldDue] = calcYieldDue(
                    cc,
                    borrowAmount,
                    daysPassed,
                );
                const principalDue = calcPrincipalDueForFullPeriods(
                    oldCR.unbilledPrincipal,
                    principalRate,
                    1,
                );
                const nextDue = accruedYieldDue.add(principalDue);

                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, expectedNextDueDate, nextDue);

                const expectedLateFeeUpdatedDate = await calendarContract.getStartOfTomorrow();
                const additionalLateFee = calcYield(
                    borrowAmount,
                    lateFeeBps,
                    (
                        await calendarContract.getDaysDiff(
                            oldDD.lateFeeUpdatedDate,
                            expectedLateFeeUpdatedDate,
                        )
                    ).toNumber(),
                );
                const expectedTotalPastDue = oldCR.totalPastDue
                    .add(oldCR.nextDue)
                    .add(additionalLateFee);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    actualCR,
                    oldCR.unbilledPrincipal.sub(principalDue),
                    expectedNextDueDate,
                    nextDue,
                    accruedYieldDue,
                    expectedTotalPastDue,
                    oldCR.missedPeriods + 1,
                    oldCR.remainingPeriods - 1,
                    CreditState.Delayed,
                );

                const actualDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    actualDD,
                    genDueDetail({
                        lateFeeUpdatedDate: expectedLateFeeUpdatedDate,
                        lateFee: oldDD.lateFee.add(additionalLateFee),
                        yieldPastDue: oldDD.yieldPastDue.add(oldCR.yieldDue),
                        principalPastDue: oldDD.principalPastDue.add(
                            oldCR.nextDue.sub(oldCR.yieldDue),
                        ),
                        accrued: accruedYieldDue,
                        committed: committedYieldDue,
                    }),
                );
            });

            it("Should update correctly if the bill is refreshed multiple times after maturity date", async function () {
                borrowAmount = toToken(20_000);
                const drawdownDate = await getFutureBlockTime(2);
                await setNextBlockTimestamp(drawdownDate);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const maturityDate = await calendarContract.getMaturityDate(
                    cc.periodDuration,
                    cc.numOfPeriods,
                    drawdownDate,
                );
                const firstRefreshDate = maturityDate.toNumber() + 600;
                await setNextBlockTimestamp(firstRefreshDate);

                const oldCR = await creditContract.getCreditRecord(creditHash);
                const expectedFirstDueDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    firstRefreshDate,
                );

                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, expectedFirstDueDate, 0);

                const actualFirstCR = await creditContract.getCreditRecord(creditHash);
                const daysPassed = await calendarContract.getDaysDiff(
                    oldCR.nextDueDate,
                    maturityDate,
                );
                const expectedYieldPastDue = calcYield(
                    borrowAmount,
                    yieldInBps,
                    daysPassed.toNumber(),
                );
                const expectedFirstLateFeeUpdatedDate =
                    await calendarContract.getStartOfNextDay(firstRefreshDate);
                const expectedFirstLateFee = calcYield(
                    borrowAmount,
                    lateFeeBps,
                    (
                        await calendarContract.getDaysDiff(
                            oldCR.nextDueDate,
                            expectedFirstLateFeeUpdatedDate,
                        )
                    ).toNumber(),
                );
                const expectedFirstCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedFirstDueDate,
                    nextDue: BN.from(0),
                    yieldDue: BN.from(0),
                    totalPastDue: borrowAmount
                        .add(oldCR.yieldDue)
                        .add(expectedYieldPastDue)
                        .add(expectedFirstLateFee),
                    missedPeriods: cc.numOfPeriods,
                    remainingPeriods: 0,
                    state: CreditState.Delayed,
                };
                checkCreditRecordsMatch(actualFirstCR, expectedFirstCR);

                const actualFirstDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    actualFirstDD,
                    genDueDetail({
                        lateFeeUpdatedDate: expectedFirstLateFeeUpdatedDate,
                        lateFee: expectedFirstLateFee,
                        principalPastDue: borrowAmount,
                        yieldPastDue: oldCR.yieldDue.add(expectedYieldPastDue),
                    }),
                );

                const secondRefreshDate =
                    (
                        await calendarContract.getStartDateOfNextPeriod(
                            cc.periodDuration,
                            firstRefreshDate,
                        )
                    ).toNumber() + 600;
                await setNextBlockTimestamp(secondRefreshDate);
                const expectedSecondDueDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    secondRefreshDate,
                );
                expect(secondRefreshDate).to.not.equal(firstRefreshDate);

                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, expectedSecondDueDate, 0);

                const actualSecondCR = await creditContract.getCreditRecord(creditHash);
                const expectedSecondLateFeeUpdatedDate =
                    await calendarContract.getStartOfNextDay(secondRefreshDate);
                const expectedSecondLateFee = calcYield(
                    borrowAmount,
                    lateFeeBps,
                    (
                        await calendarContract.getDaysDiff(
                            oldCR.nextDueDate,
                            expectedSecondLateFeeUpdatedDate,
                        )
                    ).toNumber(),
                );
                const expectedSecondCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedSecondDueDate,
                    nextDue: BN.from(0),
                    yieldDue: BN.from(0),
                    // Add the incremental late fee to past due.
                    totalPastDue: actualFirstCR.totalPastDue
                        .sub(expectedFirstLateFee)
                        .add(expectedSecondLateFee),
                    missedPeriods: actualFirstCR.missedPeriods + 1,
                    remainingPeriods: 0,
                    state: CreditState.Delayed,
                };
                checkCreditRecordsMatch(actualSecondCR, expectedSecondCR);

                const actualSecondDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    actualSecondDD,
                    genDueDetail({
                        lateFeeUpdatedDate: expectedSecondLateFeeUpdatedDate,
                        lateFee: expectedSecondLateFee,
                        principalPastDue: borrowAmount,
                        yieldPastDue: actualFirstDD.yieldPastDue,
                    }),
                );
            });

            it("Should update correctly once in the last period, and again post-maturity", async function () {
                borrowAmount = toToken(5_000);
                const drawdownDate = await getFutureBlockTime(1);
                await setNextBlockTimestamp(drawdownDate);
                await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

                // First refresh is performed before maturity.
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const maturityDate = await calendarContract.getMaturityDate(
                    cc.periodDuration,
                    cc.numOfPeriods,
                    drawdownDate,
                );
                const firstRefreshDate = maturityDate.toNumber() - 600;
                await setNextBlockTimestamp(firstRefreshDate);
                await creditManagerContract.refreshCredit(borrower.address);

                // Second refresh is performed post-maturity.
                const secondRefreshDate = maturityDate.toNumber() + 600;
                await setNextBlockTimestamp(secondRefreshDate);

                const oldCR = await creditContract.getCreditRecord(creditHash);
                const oldDD = await creditContract.getDueDetail(creditHash);
                const expectedNextDueDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    oldCR.nextDueDate,
                );

                await expect(creditManagerContract.refreshCredit(borrower.address))
                    .to.emit(creditContract, "BillRefreshed")
                    .withArgs(creditHash, expectedNextDueDate, 0);

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedLateFeeRefreshDate = await calendarContract.getStartOfTomorrow();
                const daysPassed = await calendarContract.getDaysDiff(
                    oldDD.lateFeeUpdatedDate,
                    expectedLateFeeRefreshDate,
                );
                const additionalLateFee = calcYield(
                    committedAmount,
                    lateFeeBps,
                    daysPassed.toNumber(),
                );
                const expectedCR = {
                    unbilledPrincipal: BN.from(0),
                    nextDueDate: expectedNextDueDate,
                    nextDue: BN.from(0),
                    yieldDue: BN.from(0),
                    totalPastDue: oldCR.totalPastDue
                        .add(oldCR.nextDue)
                        .add(oldCR.unbilledPrincipal)
                        .add(additionalLateFee),
                    missedPeriods: oldCR.missedPeriods + 1,
                    remainingPeriods: 0,
                    state: CreditState.Delayed,
                };
                checkCreditRecordsMatch(actualCR, expectedCR);

                const actualDD = await creditContract.getDueDetail(creditHash);
                checkDueDetailsMatch(
                    actualDD,
                    genDueDetail({
                        lateFeeUpdatedDate: expectedLateFeeRefreshDate,
                        lateFee: oldDD.lateFee.add(additionalLateFee),
                        principalPastDue: borrowAmount,
                        yieldPastDue: oldDD.yieldPastDue.add(oldCR.yieldDue),
                    }),
                );
            });
        });
    });

    describe("makePayment", function () {
        const yieldInBps = 1217,
            lateFeeBps = 300,
            latePaymentGracePeriodInDays = 5,
            remainingPeriods = 6;
        let principalRateInBps: number;
        let borrowAmount: BN, creditHash: string;
        let drawdownDate: moment.Moment,
            makePaymentDate: moment.Moment,
            firstDueDate: moment.Moment;

        beforeEach(async function () {
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
        });

        async function approveCredit() {
            await poolConfigContract.connect(poolOwner).setLatePaymentGracePeriodInDays(5);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    remainingPeriods,
                    yieldInBps,
                    toToken(100_000),
                    0,
                    true,
                );
        }

        async function drawdown() {
            // Make sure the borrower has enough first loss cover so that they
            // can drawdown.
            await borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        await borrower.getAddress(),
                    ),
                );

            const currentTS = (await getLatestBlock()).timestamp;
            drawdownDate = moment.utc(
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        currentTS,
                    )
                ).toNumber() * 1000,
            );
            drawdownDate = drawdownDate
                .add(11, "days")
                .add(13, "hours")
                .add(47, "minutes")
                .add(8, "seconds");
            await setNextBlockTimestamp(drawdownDate.unix());

            borrowAmount = toToken(50_000);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            firstDueDate = moment.utc(
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        drawdownDate.unix(),
                    )
                ).toNumber() * 1000,
            );
        }

        describe("If the borrower does not have a credit line approved", function () {
            it("Should not allow a borrower to make payment", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePayment(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");
            });
        });

        describe("If the borrower has not drawn down from the credit line", function () {
            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            it("Should not allow the borrower to make payment", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePayment(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "creditLineNotInStateForMakingPayment",
                );
            });
        });

        describe("If the borrower has drawn down from the credit line", function () {
            async function testMakePayment(
                paymentAmount: BN,
                paymentDate: moment.Moment = makePaymentDate,
                paymentInitiator: SignerWithAddress = borrower,
            ) {
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const cr = await creditContract.getCreditRecord(creditHash);
                const dd = await creditContract.getDueDetail(creditHash);
                const maturityDate = moment.utc(
                    (
                        await calendarContract.getMaturityDate(
                            cc.periodDuration,
                            cc.numOfPeriods,
                            drawdownDate.unix(),
                        )
                    ).toNumber() * 1000,
                );

                // Calculate the dues, fees and dates right before the payment is made.
                let [
                    remainingUnbilledPrincipal,
                    remainingPrincipalPastDue,
                    remainingPrincipalNextDue,
                ] = await calcPrincipalDueNew(
                    calendarContract,
                    cc,
                    cr,
                    dd,
                    paymentDate,
                    maturityDate,
                    latePaymentGracePeriodInDays,
                    principalRateInBps,
                );
                let [
                    remainingYieldPastDue,
                    remainingYieldNextDue,
                    [accruedYieldNextDue, committedYieldNextDue],
                ] = await calcYieldDueNew(
                    calendarContract,
                    cc,
                    cr,
                    dd,
                    paymentDate,
                    maturityDate,
                    latePaymentGracePeriodInDays,
                );
                let [lateFeeUpdatedDate, remainingLateFee] = await calcLateFeeNew(
                    poolConfigContract,
                    calendarContract,
                    cc,
                    cr,
                    dd,
                    paymentDate,
                    latePaymentGracePeriodInDays,
                );
                let nextDueBefore = remainingPrincipalNextDue.add(remainingYieldNextDue);

                let principalDuePaid = BN.from(0),
                    yieldDuePaid = BN.from(0),
                    unbilledPrincipalPaid = BN.from(0),
                    principalPastDuePaid = BN.from(0),
                    yieldPastDuePaid = BN.from(0),
                    lateFeePaid = BN.from(0),
                    remainingPaymentAmount = paymentAmount;
                // If there is past due, attempt to pay past due first.
                let remainingPastDue = remainingPrincipalPastDue
                    .add(remainingYieldPastDue)
                    .add(remainingLateFee);
                if (remainingPastDue.gt(0)) {
                    if (paymentAmount.gte(remainingPastDue)) {
                        yieldPastDuePaid = remainingYieldPastDue;
                        remainingYieldPastDue = BN.from(0);
                        principalPastDuePaid = remainingPrincipalPastDue;
                        remainingPrincipalPastDue = BN.from(0);
                        lateFeePaid = remainingLateFee;
                        remainingLateFee = BN.from(0);
                        remainingPaymentAmount = paymentAmount.sub(remainingPastDue);
                    } else if (paymentAmount.gte(remainingYieldPastDue.add(remainingLateFee))) {
                        principalPastDuePaid = paymentAmount
                            .sub(remainingYieldPastDue)
                            .sub(remainingLateFee);
                        remainingPrincipalPastDue =
                            remainingPrincipalPastDue.sub(principalPastDuePaid);
                        yieldPastDuePaid = remainingYieldPastDue;
                        remainingYieldPastDue = BN.from(0);
                        lateFeePaid = remainingLateFee;
                        remainingLateFee = BN.from(0);
                        remainingPaymentAmount = BN.from(0);
                    } else if (paymentAmount.gte(remainingYieldPastDue)) {
                        lateFeePaid = paymentAmount.sub(remainingYieldPastDue);
                        remainingLateFee = remainingLateFee.sub(lateFeePaid);
                        yieldPastDuePaid = remainingYieldPastDue;
                        remainingYieldPastDue = BN.from(0);
                        remainingPaymentAmount = BN.from(0);
                    } else {
                        yieldPastDuePaid = paymentAmount;
                        remainingYieldPastDue = remainingYieldPastDue.sub(paymentAmount);
                        remainingPaymentAmount = BN.from(0);
                    }
                    remainingPastDue = remainingPrincipalPastDue
                        .add(remainingYieldPastDue)
                        .add(remainingLateFee);
                }
                // Then pay next due.
                let nextDueAfter = nextDueBefore;
                if (remainingPaymentAmount.gt(0)) {
                    if (remainingPaymentAmount.gte(nextDueBefore)) {
                        yieldDuePaid = remainingYieldNextDue;
                        principalDuePaid = remainingPrincipalNextDue;
                        remainingPaymentAmount = remainingPaymentAmount.sub(nextDueBefore);
                        remainingYieldNextDue = BN.from(0);
                        remainingPrincipalNextDue = BN.from(0);
                        unbilledPrincipalPaid = minBigNumber(
                            remainingUnbilledPrincipal,
                            remainingPaymentAmount,
                        );
                        remainingUnbilledPrincipal =
                            remainingUnbilledPrincipal.sub(unbilledPrincipalPaid);
                        remainingPaymentAmount = remainingPaymentAmount.sub(unbilledPrincipalPaid);
                    } else if (remainingPaymentAmount.gte(remainingYieldNextDue)) {
                        yieldDuePaid = remainingYieldNextDue;
                        principalDuePaid = remainingPaymentAmount.sub(remainingYieldNextDue);
                        remainingPrincipalNextDue = remainingPrincipalNextDue.sub(
                            remainingPaymentAmount.sub(remainingYieldNextDue),
                        );
                        remainingYieldNextDue = BN.from(0);
                        remainingPaymentAmount = BN.from(0);
                    } else {
                        yieldDuePaid = remainingPaymentAmount;
                        remainingYieldNextDue = remainingYieldNextDue.sub(remainingPaymentAmount);
                        remainingPaymentAmount = BN.from(0);
                    }
                    nextDueAfter = remainingYieldNextDue.add(remainingPrincipalNextDue);
                }

                // Clear late fee updated date if the bill is paid off
                if (remainingPastDue.isZero()) {
                    lateFeeUpdatedDate = BN.from(0);
                }

                let newDueDate;
                if (
                    paymentDate.isSameOrBefore(
                        getNextBillRefreshDate(cr, paymentDate, latePaymentGracePeriodInDays),
                    )
                ) {
                    newDueDate = cr.nextDueDate;
                } else {
                    newDueDate = await calendarContract.getStartDateOfNextPeriod(
                        cc.periodDuration,
                        paymentDate.unix(),
                    );
                }
                const paymentAmountUsed = paymentAmount.sub(remainingPaymentAmount);

                const borrowerBalanceBefore = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );

                // console.log(
                //     `paymentAmountUsed ${paymentAmountUsed}`,
                //     `newDueDate ${newDueDate}`,
                //     `nextDueAfter ${nextDueAfter}`,
                //     `remainingPastDue ${remainingPastDue}`,
                //     `remainingUnbilledPrincipal ${remainingUnbilledPrincipal}`,
                //     `yieldDuePaid ${yieldDuePaid}`,
                //     `principalDuePaid ${principalDuePaid}`,
                //     `unbilledPrincipalPaid ${unbilledPrincipalPaid}`,
                //     `yieldPastDuePaid ${yieldPastDuePaid}`,
                //     `lateFeePaid ${lateFeePaid}`,
                //     `principalPastDuePaid ${principalPastDuePaid}`,
                //     `remaining late fee ${remainingLateFee}`
                // );
                if (paymentAmountUsed.gt(ethers.constants.Zero)) {
                    let poolDistributionEventName = "";
                    if (cr.state === CreditState.Defaulted) {
                        poolDistributionEventName = "LossRecoveryDistributed";
                    } else if (yieldPastDuePaid.add(yieldDuePaid).add(lateFeePaid).gt(0)) {
                        poolDistributionEventName = "ProfitDistributed";
                    }

                    if (poolDistributionEventName !== "") {
                        await expect(
                            creditContract
                                .connect(paymentInitiator)
                                .makePayment(borrower.getAddress(), paymentAmount),
                        )
                            .to.emit(creditContract, "PaymentMade")
                            .withArgs(
                                await borrower.getAddress(),
                                await borrower.getAddress(),
                                paymentAmountUsed,
                                yieldDuePaid,
                                principalDuePaid,
                                unbilledPrincipalPaid,
                                yieldPastDuePaid,
                                lateFeePaid,
                                principalPastDuePaid,
                                await paymentInitiator.getAddress(),
                            )
                            .to.emit(poolContract, poolDistributionEventName);
                    } else {
                        await expect(
                            creditContract
                                .connect(paymentInitiator)
                                .makePayment(borrower.getAddress(), paymentAmount),
                        )
                            .to.emit(creditContract, "PaymentMade")
                            .withArgs(
                                await borrower.getAddress(),
                                await borrower.getAddress(),
                                paymentAmountUsed,
                                yieldDuePaid,
                                principalDuePaid,
                                unbilledPrincipalPaid,
                                yieldPastDuePaid,
                                lateFeePaid,
                                principalPastDuePaid,
                                await paymentInitiator.getAddress(),
                            );
                    }
                } else {
                    await expect(
                        creditContract
                            .connect(paymentInitiator)
                            .makePayment(borrower.getAddress(), paymentAmount),
                    ).not.to.emit(creditContract, "PaymentMade");
                }

                // Make sure the funds has been transferred from the borrower to the pool safe.
                const borrowerBalanceAfter = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.equal(
                    paymentAmountUsed,
                );

                const newCR = await creditContract.getCreditRecord(creditHash);
                let periodsPassed = 0;
                if (cr.state === CreditState.Approved) {
                    periodsPassed = 1;
                } else if (cr.state === CreditState.GoodStanding) {
                    if (
                        paymentDate.isAfter(
                            getLatePaymentGracePeriodDeadline(cr, latePaymentGracePeriodInDays),
                        )
                    ) {
                        periodsPassed =
                            (
                                await calendarContract.getNumPeriodsPassed(
                                    cc.periodDuration,
                                    cr.nextDueDate,
                                    paymentDate.unix(),
                                )
                            ).toNumber() + 1;
                    }
                } else if (paymentDate.isAfter(moment.utc(cr.nextDueDate.toNumber() * 1000))) {
                    periodsPassed =
                        (
                            await calendarContract.getNumPeriodsPassed(
                                cc.periodDuration,
                                cr.nextDueDate,
                                paymentDate.unix(),
                            )
                        ).toNumber() + 1;
                }
                const remainingPeriods = Math.max(cr.remainingPeriods - periodsPassed, 0);
                // Whether the bill is late up until payment is made.
                const isLate =
                    cr.missedPeriods > 0 ||
                    (cr.nextDue.gt(0) &&
                        paymentDate.isAfter(
                            getLatePaymentGracePeriodDeadline(cr, latePaymentGracePeriodInDays),
                        ));
                const missedPeriods =
                    !isLate || remainingPastDue.isZero() ? 0 : cr.missedPeriods + periodsPassed;
                let creditState;
                if (remainingPastDue.isZero()) {
                    if (nextDueAfter.isZero() && remainingUnbilledPrincipal.isZero()) {
                        if (remainingPeriods === 0) {
                            creditState = CreditState.Deleted;
                        } else {
                            creditState = CreditState.GoodStanding;
                        }
                    } else if (cr.state === CreditState.Delayed) {
                        creditState = CreditState.GoodStanding;
                    } else {
                        creditState = cr.state;
                    }
                } else if (missedPeriods != 0) {
                    if (cr.state === CreditState.GoodStanding) {
                        creditState = CreditState.Delayed;
                    } else {
                        creditState = cr.state;
                    }
                } else {
                    creditState = cr.state;
                }
                let expectedNewCR, expectedNewDD;
                if (
                    nextDueAfter.isZero() &&
                    !remainingUnbilledPrincipal.isZero() &&
                    newDueDate.lt(paymentDate.unix())
                ) {
                    // We expect the bill to be refreshed if all next due is paid off and the bill is in the
                    // new billing cycle.
                    const [accrued, committed] = calcYieldDue(
                        cc,
                        remainingUnbilledPrincipal,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    const yieldDue = maxBigNumber(accrued, committed);
                    const principalDue = calcPrincipalDueForFullPeriods(
                        remainingUnbilledPrincipal,
                        principalRateInBps,
                        1,
                    );
                    newDueDate = await calendarContract.getStartDateOfNextPeriod(
                        cc.periodDuration,
                        newDueDate,
                    );
                    expectedNewCR = {
                        unbilledPrincipal: remainingUnbilledPrincipal.sub(principalDue),
                        nextDueDate: newDueDate,
                        nextDue: yieldDue.add(principalDue),
                        yieldDue: yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: remainingPeriods - 1,
                        state: CreditState.GoodStanding,
                    };
                    expectedNewDD = {
                        lateFeeUpdatedDate: 0,
                        lateFee: 0,
                        principalPastDue: 0,
                        yieldPastDue: 0,
                        accrued: accrued,
                        committed: committed,
                        paid: 0,
                    };
                } else {
                    expectedNewCR = {
                        unbilledPrincipal: remainingUnbilledPrincipal,
                        nextDueDate: newDueDate,
                        nextDue: nextDueAfter,
                        yieldDue: remainingYieldNextDue,
                        totalPastDue: remainingPastDue,
                        missedPeriods,
                        remainingPeriods,
                        state: creditState,
                    };
                    const yieldPaidInCurrentCycle =
                        newDueDate === cr.nextDueDate ? dd.paid.add(yieldDuePaid) : yieldDuePaid;
                    expectedNewDD = {
                        lateFeeUpdatedDate,
                        lateFee: remainingLateFee,
                        principalPastDue: remainingPrincipalPastDue,
                        yieldPastDue: remainingYieldPastDue,
                        accrued: accruedYieldNextDue,
                        committed: committedYieldNextDue,
                        paid: yieldPaidInCurrentCycle,
                    };
                }
                await checkCreditRecordsMatch(newCR, expectedNewCR);

                const newDD = await creditContract.getDueDetail(creditHash);
                await checkDueDetailsMatch(newDD, expectedNewDD);
            }

            describe("If the principal rate is zero", function () {
                async function prepareForMakePayment() {
                    principalRateInBps = 0;
                    await poolConfigContract.connect(poolOwner).setFeeStructure({
                        yieldInBps,
                        minPrincipalRateInBps: principalRateInBps,
                        lateFeeBps,
                    });
                    await approveCredit();
                    await drawdown();
                }

                beforeEach(async function () {
                    await loadFixture(prepareForMakePayment);
                });

                describe("If the bill is currently in good standing", function () {
                    describe("When the payment is made within the current billing cycle", function () {
                        async function prepareForMakePaymentInCurrentBillingCycle() {
                            makePaymentDate = drawdownDate
                                .clone()
                                .add(16, "days")
                                .add(2, "hours")
                                .add(31, "seconds");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInCurrentBillingCycle);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the PDS to make partial payment from the borrower's wallet that covers part of yield next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.sub(toToken(1));
                            await testMakePayment(
                                paymentAmount,
                                makePaymentDate,
                                pdsServiceAccount,
                            );
                        });

                        it("Should allow the borrower to make full payment that covers all of next due and part of unbilled principal", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.add(borrowAmount).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );

                            // Make a series of payment gradually and eventually pay off the bill.
                            await testMakePayment(yieldNextDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add(4, "hours");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(borrowAmount, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate.clone().add("3", "hours");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(toToken(1), thirdPaymentDate);
                        });
                    });

                    describe("When the payment is made after the due date of the current billing cycle, but within the late payment grace period", function () {
                        async function prepareForMakePaymentWithinLatePaymentGracePeriod() {
                            makePaymentDate = firstDueDate
                                .clone()
                                .add(latePaymentGracePeriodInDays, "days")
                                .subtract(1, "second");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentWithinLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of next due and part of unbilled principal", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.add(borrowAmount).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            let [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );

                            // Make a series of payment gradually and eventually pay off the bill.
                            await testMakePayment(yieldNextDue);

                            // The second payment is made after the late payment grace period of the first due date.
                            // But since there is no next due, there is no late fee. However, there is new
                            // yield due since a new bill is generated.
                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            await testMakePayment(
                                borrowAmount.add(yieldNextDue),
                                secondPaymentDate,
                            );
                            cr = await creditContract.getCreditRecord(creditHash);
                            expect(cr.unbilledPrincipal).to.equal(0);
                            expect(cr.nextDue).to.equal(0);
                            expect(cr.totalPastDue).to.equal(0);

                            const thirdPaymentDate = secondPaymentDate.clone().add(38, "minutes");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(toToken(1), thirdPaymentDate);
                        });
                    });

                    describe("When the payment is made after the late payment grace period", function () {
                        async function prepareForMakePaymentAfterLatePaymentGracePeriod() {
                            makePaymentDate = firstDueDate
                                .clone()
                                .add(latePaymentGracePeriodInDays, "days")
                                .add(1, "second");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of late fee", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(yieldNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(lateFee)
                                .add(borrowAmount)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue, thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(borrowAmount, fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await testMakePayment(toToken(1), fifthPaymentDate);
                        });
                    });

                    describe("When the payment is in the final period", function () {
                        async function prepareForMakePaymentInFinalPeriod() {
                            makePaymentDate = drawdownDate
                                .clone()
                                .add(remainingPeriods - 1, "months");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInFinalPeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of late fee", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(yieldNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill and close the credit line", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);

                            // Payment should no longer be allowed after the credit line is deleted.
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), paymentAmount),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(lateFee)
                                .add(borrowAmount)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            let [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                thirdPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue.add(lateFee), thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                fourthPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(borrowAmount.add(lateFee), fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), toToken(1)),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });
                    });

                    describe("When the payment is made after the maturity date", function () {
                        async function prepareForMakePaymentAfterMaturityDate() {
                            // The payment is made after the late payment grace period of the maturity date.
                            makePaymentDate = drawdownDate
                                .clone()
                                .add(remainingPeriods, "months")
                                .add(latePaymentGracePeriodInDays + 1, "days")
                                .add(58, "minutes");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterMaturityDate);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of late fee", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill and close the credit line", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);

                            // Payment should no longer be allowed after the credit line is deleted.
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), paymentAmount),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(lateFee)
                                .add(borrowAmount)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            let [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                thirdPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(borrowAmount.add(lateFee), thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), toToken(1)),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });
                    });
                });

                describe("If the bill is delayed", function () {
                    let billRefreshDate: moment.Moment;

                    async function prepareForLateBillPayment() {
                        // Refresh the credit many cycles after drawdown so that the bill is delayed
                        // at the time payment is made.
                        billRefreshDate = drawdownDate
                            .clone()
                            .add(2, "months")
                            .add(2, "days")
                            .add(4, "hours");
                        await setNextBlockTimestamp(billRefreshDate.unix());
                        await creditManagerContract.refreshCredit(borrower.getAddress());
                        const cr = await creditContract.getCreditRecord(creditHash);
                        expect(cr.state).to.equal(CreditState.Delayed);
                    }

                    beforeEach(async function () {
                        await loadFixture(prepareForLateBillPayment);
                    });

                    describe("When the payment is made within the current billing cycle", function () {
                        async function prepareForMakePaymentInCurrentBillingCycle() {
                            makePaymentDate = billRefreshDate.clone().add(2, "hours");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInCurrentBillingCycle);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of late fee", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(yieldNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            let [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                thirdPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue.add(lateFee), thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                fourthPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            expect(lateFee).to.equal(0);
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(borrowAmount.add(lateFee), fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await testMakePayment(toToken(1), fifthPaymentDate);
                        });
                    });

                    describe("When the payment is made outside of the current billing cycle", function () {
                        async function prepareForMakePaymentAfterLatePaymentGracePeriod() {
                            makePaymentDate = billRefreshDate.add(1, "month").add(12, "hours");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield and principal past due and part of late fee", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(yieldNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            let [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                secondPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                thirdPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue.add(lateFee), thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            cr = await creditContract.getCreditRecord(creditHash);
                            dd = await creditContract.getDueDetail(creditHash);
                            [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                fourthPaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            expect(lateFee).to.equal(0);
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(borrowAmount.add(lateFee), fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await testMakePayment(toToken(1), fifthPaymentDate);
                        });
                    });
                });

                describe("If the bill is defaulted", function () {
                    let triggerDefaultDate: moment.Moment;

                    async function prepareForDefaultedBillPayment() {
                        const defaultGracePeriodInMonths = 1;
                        await poolConfigContract
                            .connect(poolOwner)
                            .setPoolDefaultGracePeriod(defaultGracePeriodInMonths);

                        triggerDefaultDate = drawdownDate
                            .clone()
                            .add(2, "months")
                            .add(2, "days")
                            .add(4, "hours");
                        await setNextBlockTimestamp(triggerDefaultDate.unix());
                        await creditManagerContract
                            .connect(eaServiceAccount)
                            .triggerDefault(borrower.getAddress());
                        const cr = await creditContract.getCreditRecord(creditHash);
                        expect(cr.state).to.equal(CreditState.Defaulted);
                    }

                    beforeEach(async function () {
                        await loadFixture(prepareForDefaultedBillPayment);
                    });

                    describe("When the payment is made within the current billing cycle", function () {
                        async function prepareForMakePaymentInCurrentBillingCycle() {
                            makePaymentDate = triggerDefaultDate.clone().add(2, "hours");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInCurrentBillingCycle);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of late fee", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(yieldNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(borrowAmount);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            let cr = await creditContract.getCreditRecord(creditHash);
                            let dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                triggerDefaultDate,
                                latePaymentGracePeriodInDays,
                            );

                            // First payment pays off the yield past due and late fee.
                            await testMakePayment(yieldPastDue.add(lateFee));

                            // Second payment pays off the yield next due.
                            const secondPaymentDate = makePaymentDate.clone().add("39", "seconds");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(yieldNextDue, secondPaymentDate);

                            // Third payment pays off the principal.
                            const thirdPaymentDate = secondPaymentDate.clone().add("11", "hours");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(borrowAmount, thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(toToken(1), fourthPaymentDate);
                        });
                    });
                });
            });

            describe("If the principal rate is non-zero", function () {
                async function prepareForMakePayment() {
                    principalRateInBps = 200;
                    await poolConfigContract.connect(poolOwner).setFeeStructure({
                        yieldInBps,
                        minPrincipalRateInBps: principalRateInBps,
                        lateFeeBps,
                    });
                    await approveCredit();
                    await drawdown();
                }

                beforeEach(async function () {
                    await loadFixture(prepareForMakePayment);
                });

                describe("If the bill is currently in good standing", function () {
                    describe("When the payment is made within the current billing cycle", function () {
                        async function prepareForMakePaymentInCurrentBillingCycle() {
                            makePaymentDate = drawdownDate
                                .clone()
                                .add(16, "days")
                                .add(2, "hours")
                                .add(31, "seconds");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInCurrentBillingCycle);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers part of all of yield next due and part of principal next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers part of all of next due and part of unbilled principal", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, , principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );

                            // Make a series of payment gradually and eventually pay off the bill.
                            await testMakePayment(yieldNextDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add(4, "hours");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(principalNextDue, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate.clone().add(3, "hours");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(unbilledPrincipal, thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add(58, "minutes");
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(toToken(1), thirdPaymentDate);
                        });
                    });

                    describe("When the payment is made after the due date of the current billing cycle, but within the late payment grace period", function () {
                        async function prepareForMakePaymentWithinLatePaymentGracePeriod() {
                            makePaymentDate = firstDueDate
                                .clone()
                                .add(latePaymentGracePeriodInDays, "days")
                                .subtract(1, "second");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentWithinLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers part of all of yield next due and part of principal next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldNextDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of next due and part of unbilled principal", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, , principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldNextDue
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, , principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );

                            await testMakePayment(yieldNextDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(principalNextDue, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate.clone().add(38, "minutes");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(unbilledPrincipal, thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add(1, "hour");
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(toToken(1), thirdPaymentDate);
                        });
                    });

                    describe("When the payment is made after the late payment grace period", function () {
                        async function prepareForMakePaymentAfterLatePaymentGracePeriod() {
                            makePaymentDate = firstDueDate
                                .clone()
                                .add(latePaymentGracePeriodInDays, "days")
                                .add(1, "second");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield and late fee and part of principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [principalPastDue, principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(principalPastDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make multiple payments", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );

                            await testMakePayment(yieldPastDue);

                            const secondPaymentDate = makePaymentDate
                                .clone()
                                .add(1, "day")
                                .add("4", "hours")
                                .add(5, "minutes");
                            setNextBlockTimestamp(secondPaymentDate.unix());
                            await testMakePayment(lateFee, secondPaymentDate);

                            const thirdPaymentDate = secondPaymentDate
                                .clone()
                                .add("39", "seconds");
                            setNextBlockTimestamp(thirdPaymentDate.unix());
                            await testMakePayment(yieldNextDue, thirdPaymentDate);

                            const fourthPaymentDate = thirdPaymentDate.clone().add("11", "hours");
                            setNextBlockTimestamp(fourthPaymentDate.unix());
                            await testMakePayment(principalNextDue, fourthPaymentDate);

                            const fifthPaymentDate = fourthPaymentDate
                                .clone()
                                .add(2, "days")
                                .add("21", "hours")
                                .add(1, "second");
                            setNextBlockTimestamp(fifthPaymentDate.unix());
                            await testMakePayment(unbilledPrincipal, fifthPaymentDate);

                            const sixthPaymentDate = fifthPaymentDate.clone().add(46, "seconds");
                            setNextBlockTimestamp(sixthPaymentDate.unix());
                            await testMakePayment(toToken(1), sixthPaymentDate);
                        });
                    });

                    describe("When the payment is in the final period", function () {
                        async function prepareForMakePaymentInFinalPeriod() {
                            makePaymentDate = drawdownDate
                                .clone()
                                .add(remainingPeriods - 1, "months");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInFinalPeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and late fee and part of principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [principalPastDue, principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill and close the credit line", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);

                            // Payment should no longer be allowed after the credit line is deleted.
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), paymentAmount),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(principalPastDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                        });
                    });

                    describe("When the payment is made after maturity date", function () {
                        async function prepareForMakePaymentAfterMaturityDate() {
                            makePaymentDate = drawdownDate
                                .clone()
                                .add(remainingPeriods, "months")
                                .add(latePaymentGracePeriodInDays + 1, "days")
                                .add(58, "minutes");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterMaturityDate);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and late fee and part of principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill and close the credit line", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);

                            // Payment should no longer be allowed after the credit line is deleted.
                            await expect(
                                creditContract
                                    .connect(borrower)
                                    .makePayment(borrower.getAddress(), paymentAmount),
                            ).to.be.revertedWithCustomError(
                                creditContract,
                                "creditLineNotInStateForMakingPayment",
                            );
                        });

                        it("Should allow the borrower to make payment that covers the entire bill, and only the pay off amount is collected", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const paymentAmount = yieldPastDue
                                .add(yieldNextDue)
                                .add(principalPastDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal)
                                .add(toToken(1));
                        });
                    });
                });

                describe("If the bill is delayed", function () {
                    let billRefreshDate: moment.Moment;

                    async function prepareForLateBillPayment() {
                        // Refresh the credit many cycles after drawdown so that the bill is delayed
                        // at the time payment is made.
                        billRefreshDate = drawdownDate
                            .clone()
                            .add(2, "months")
                            .add(2, "days")
                            .add(4, "hours");
                        await setNextBlockTimestamp(billRefreshDate.unix());
                        await creditManagerContract.refreshCredit(borrower.getAddress());
                        const cr = await creditContract.getCreditRecord(creditHash);
                        expect(cr.state).to.equal(CreditState.Delayed);
                    }

                    beforeEach(async function () {
                        await loadFixture(prepareForLateBillPayment);
                    });

                    describe("When the payment is made within the current billing cycle", function () {
                        async function prepareForMakePaymentInCurrentBillingCycle() {
                            makePaymentDate = billRefreshDate.clone().add(2, "hours");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentInCurrentBillingCycle);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and late fee and part of principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [principalPastDue, principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });
                    });

                    describe("When the payment is made outside of the current billing cycle", function () {
                        async function prepareForMakePaymentAfterLatePaymentGracePeriod() {
                            makePaymentDate = billRefreshDate.add(1, "month").add(12, "hours");
                            await setNextBlockTimestamp(makePaymentDate.unix());
                        }

                        beforeEach(async function () {
                            await loadFixture(prepareForMakePaymentAfterLatePaymentGracePeriod);
                        });

                        it("Should allow the borrower to make partial payment that covers part of yield past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.sub(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and part of principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of yield past due and late fee and principal past due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue.add(lateFee).add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make partial payment that covers all of past due and part of next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [, principalPastDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(toToken(1));
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to make full payment that covers all of past and next due", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [principalPastDue, principalNextDue] = await calcPrincipalDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                                principalRateInBps,
                            );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue);
                            await testMakePayment(paymentAmount);
                        });

                        it("Should allow the borrower to payoff the bill", async function () {
                            const cc = await creditManagerContract.getCreditConfig(creditHash);
                            const cr = await creditContract.getCreditRecord(creditHash);
                            const dd = await creditContract.getDueDetail(creditHash);
                            const maturityDate = await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            );

                            const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                moment.utc(maturityDate.toNumber() * 1000),
                                latePaymentGracePeriodInDays,
                            );
                            const [unbilledPrincipal, principalPastDue, principalNextDue] =
                                await calcPrincipalDueNew(
                                    calendarContract,
                                    cc,
                                    cr,
                                    dd,
                                    makePaymentDate,
                                    moment.utc(maturityDate.toNumber() * 1000),
                                    latePaymentGracePeriodInDays,
                                    principalRateInBps,
                                );
                            const [, lateFee] = await calcLateFeeNew(
                                poolConfigContract,
                                calendarContract,
                                cc,
                                cr,
                                dd,
                                makePaymentDate,
                                latePaymentGracePeriodInDays,
                            );
                            const paymentAmount = yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue)
                                .add(unbilledPrincipal);
                            await testMakePayment(paymentAmount);
                        });
                    });
                });

                it("Should not allow payment when the protocol is paused or pool is not on", async function () {
                    await humaConfigContract.connect(protocolOwner).pause();
                    await expect(
                        creditContract.makePayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                    await humaConfigContract.connect(protocolOwner).unpause();

                    await poolContract.connect(poolOwner).disablePool();
                    await expect(
                        creditContract.makePayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                    await poolContract.connect(poolOwner).enablePool();
                });

                it("Should not allow non-borrower or non-PDS service account to make payment", async function () {
                    await expect(
                        creditContract
                            .connect(borrower2)
                            .makePayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "paymentDetectionServiceAccountRequired",
                    );
                });

                it("Should not allow the borrower to make payment with 0 amount", async function () {
                    await expect(
                        creditContract.connect(borrower).makePayment(borrower.getAddress(), 0),
                    ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");
                });
            });
        });
    });

    describe("makePrincipalPayment", function () {
        const yieldInBps = 1217,
            lateFeeBps = 300,
            latePaymentGracePeriodInDays = 5,
            remainingPeriods = 6;
        let principalRateInBps: number;
        let borrowAmount: BN, creditHash: string;
        let drawdownDate: moment.Moment,
            makePaymentDate: moment.Moment,
            firstDueDate: moment.Moment;

        beforeEach(async function () {
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
        });

        async function approveCredit() {
            await poolConfigContract.connect(poolOwner).setLatePaymentGracePeriodInDays(5);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    remainingPeriods,
                    yieldInBps,
                    toToken(100_000),
                    0,
                    true,
                );
        }

        async function drawdown() {
            // Make sure the borrower has enough first loss cover so that they
            // can drawdown.
            await borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        await borrower.getAddress(),
                    ),
                );

            const currentTS = (await getLatestBlock()).timestamp;
            drawdownDate = moment.utc(
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        currentTS,
                    )
                ).toNumber() * 1000,
            );
            drawdownDate = drawdownDate
                .add(11, "days")
                .add(13, "hours")
                .add(47, "minutes")
                .add(8, "seconds");
            await setNextBlockTimestamp(drawdownDate.unix());

            borrowAmount = toToken(50_000);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            firstDueDate = moment.utc(
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        drawdownDate.unix(),
                    )
                ).toNumber() * 1000,
            );
        }

        describe("If the borrower does not have a credit line approved", function () {
            it("Should not allow a borrower to make principal payment", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(creditContract, "notBorrower");
            });
        });

        describe("If the borrower has not drawn down from the credit line", function () {
            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            it("Should not allow the borrower to make principal payment", async function () {
                await expect(
                    creditContract
                        .connect(borrower)
                        .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(
                    creditContract,
                    "creditLineNotInStateForMakingPrincipalPayment",
                );
            });
        });

        describe("If the borrower has drawn down from the credit line", function () {
            async function testMakePrincipalPayment(
                paymentDate: moment.Moment,
                paymentAmount: BN,
                paymentAmountCollected: BN,
                nextDueDate: moment.Moment,
                principalDuePaid: BN,
                unbilledPrincipalPaid: BN,
                expectedNewCR: CreditRecordStruct,
                expectedNewDD: DueDetailStruct,
                paymentInitiator: SignerWithAddress = borrower,
            ) {
                await setNextBlockTimestamp(paymentDate.unix());

                const borrowerBalanceBefore = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                const poolSafeBalanceBefore = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                if (paymentAmountCollected.gt(0)) {
                    await expect(
                        creditContract
                            .connect(paymentInitiator)
                            .makePrincipalPayment(borrower.getAddress(), paymentAmount),
                    )
                        .to.emit(creditContract, "PrincipalPaymentMade")
                        .withArgs(
                            await borrower.getAddress(),
                            await borrower.getAddress(),
                            paymentAmountCollected,
                            nextDueDate.unix(),
                            BN.from(expectedNewCR.nextDue).sub(BN.from(expectedNewCR.yieldDue)),
                            expectedNewCR.unbilledPrincipal,
                            principalDuePaid,
                            unbilledPrincipalPaid,
                            await paymentInitiator.getAddress(),
                        );
                } else {
                    await expect(
                        creditContract
                            .connect(paymentInitiator)
                            .makePrincipalPayment(borrower.getAddress(), paymentAmount),
                    ).not.to.emit(creditContract, "PrincipalPaymentMade");
                }
                const borrowerBalanceAfter = await mockTokenContract.balanceOf(
                    borrower.getAddress(),
                );
                expect(borrowerBalanceBefore.sub(borrowerBalanceAfter)).to.equal(
                    paymentAmountCollected,
                );
                const poolSafeBalanceAfter = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                expect(poolSafeBalanceAfter.sub(poolSafeBalanceBefore)).to.equal(
                    paymentAmountCollected,
                );

                const newCR = await creditContract.getCreditRecord(creditHash);
                await checkCreditRecordsMatch(newCR, expectedNewCR);

                const newDD = await creditContract.getDueDetail(creditHash);
                await checkDueDetailsMatch(newDD, expectedNewDD);
            }

            describe("When principal rate is zero", function () {
                async function prepareForMakePayment() {
                    principalRateInBps = 0;
                    await poolConfigContract.connect(poolOwner).setFeeStructure({
                        yieldInBps,
                        minPrincipalRateInBps: principalRateInBps,
                        lateFeeBps,
                    });
                    await approveCredit();
                    await drawdown();
                }

                beforeEach(async function () {
                    await loadFixture(prepareForMakePayment);
                });

                it("Should allow the borrower to pay for the unbilled principal once in the current billing cycle", async function () {
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);

                    makePaymentDate = drawdownDate
                        .clone()
                        .add(2, "days")
                        .add(22, "hours")
                        .add(14, "seconds");
                    const nextDueDate = firstDueDate;
                    const expectedNewCR = {
                        unbilledPrincipal: 0,
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue,
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    const expectedNewDD = {
                        lateFeeUpdatedDate: BN.from(0),
                        lateFee: BN.from(0),
                        principalPastDue: BN.from(0),
                        yieldPastDue: BN.from(0),
                        committed: dd.committed,
                        accrued: dd.accrued,
                        paid: BN.from(0),
                    };
                    await testMakePrincipalPayment(
                        makePaymentDate,
                        borrowAmount,
                        borrowAmount,
                        nextDueDate,
                        BN.from(0),
                        borrowAmount,
                        expectedNewCR,
                        expectedNewDD,
                    );
                });

                it("Should allow the PDS to pay for the unbilled principal once in the current billing cycle from the borrower's wallet", async function () {
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);

                    makePaymentDate = drawdownDate
                        .clone()
                        .add(2, "days")
                        .add(22, "hours")
                        .add(14, "seconds");
                    const nextDueDate = firstDueDate;
                    const expectedNewCR = {
                        unbilledPrincipal: 0,
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue,
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    const expectedNewDD = {
                        lateFeeUpdatedDate: BN.from(0),
                        lateFee: BN.from(0),
                        principalPastDue: BN.from(0),
                        yieldPastDue: BN.from(0),
                        committed: dd.committed,
                        accrued: dd.accrued,
                        paid: BN.from(0),
                    };
                    await testMakePrincipalPayment(
                        makePaymentDate,
                        borrowAmount,
                        borrowAmount,
                        nextDueDate,
                        BN.from(0),
                        borrowAmount,
                        expectedNewCR,
                        expectedNewDD,
                        pdsServiceAccount,
                    );
                });

                it("Should allow the borrower to make multiple payments for the unbilled principal within the same period", async function () {
                    const cc = await creditManagerContract.getCreditConfig(creditHash);
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (
                            await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            )
                        ).toNumber() * 1000,
                    );

                    makePaymentDate = drawdownDate
                        .clone()
                        .add(2, "days")
                        .add(22, "hours")
                        .add(14, "seconds");
                    const nextDueDate = firstDueDate;
                    const firstPaymentAmount = toToken(20_000);
                    let expectedNewCR = {
                        unbilledPrincipal: borrowAmount.sub(firstPaymentAmount),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue,
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        makePaymentDate,
                        firstPaymentAmount,
                        firstPaymentAmount,
                        firstDueDate,
                        BN.from(0),
                        firstPaymentAmount,
                        expectedNewCR,
                        dd,
                    );

                    // Second payment pays off the unbilled principal.
                    const secondPaymentDate = makePaymentDate.clone().add(1, "day");
                    const secondPaymentAmount = borrowAmount.sub(toToken(20_000));
                    expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue,
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        secondPaymentDate,
                        secondPaymentAmount,
                        secondPaymentAmount,
                        nextDueDate,
                        BN.from(0),
                        secondPaymentAmount,
                        expectedNewCR,
                        dd,
                    );

                    // Third payment is a no-op since the principal has already been paid off.
                    const thirdPaymentDate = secondPaymentDate.clone().add(16, "hours");
                    const thirdPaymentAmount = toToken(10_000);
                    await testMakePrincipalPayment(
                        thirdPaymentDate,
                        thirdPaymentAmount,
                        BN.from(0),
                        nextDueDate,
                        BN.from(0),
                        BN.from(0),
                        expectedNewCR,
                        dd,
                    );
                });

                it("Should allow the borrower to payoff the unbilled principal in the last period and close the credit line", async function () {
                    const cc = await creditManagerContract.getCreditConfig(creditHash);
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (
                            await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            )
                        ).toNumber() * 1000,
                    );

                    // First payment pays off everything except the unbilled principal.
                    makePaymentDate = drawdownDate.clone().add(remainingPeriods - 1, "months");
                    const [
                        yieldPastDue,
                        yieldNextDue,
                        [accruedYieldNextDue, committedYieldNextDue],
                    ] = await calcYieldDueNew(
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        maturityDate,
                        latePaymentGracePeriodInDays,
                    );
                    const [, lateFee] = await calcLateFeeNew(
                        poolConfigContract,
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        latePaymentGracePeriodInDays,
                    );
                    await setNextBlockTimestamp(makePaymentDate.unix());
                    await creditContract
                        .connect(borrower)
                        .makePayment(
                            borrower.getAddress(),
                            yieldPastDue.add(yieldNextDue).add(lateFee),
                        );

                    // Second payment pays off the unbilled principal.
                    const secondPaymentDate = makePaymentDate.clone().add(1, "day");
                    const nextDueDate = maturityDate;
                    const expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: BN.from(0),
                        yieldDue: BN.from(0),
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: 0,
                        state: CreditState.Deleted,
                    };
                    const expectedNewDD = {
                        lateFeeUpdatedDate: 0,
                        lateFee: BN.from(0),
                        principalPastDue: BN.from(0),
                        yieldPastDue: BN.from(0),
                        committed: committedYieldNextDue,
                        accrued: accruedYieldNextDue,
                        paid: yieldNextDue,
                    };
                    await testMakePrincipalPayment(
                        secondPaymentDate,
                        borrowAmount,
                        borrowAmount,
                        nextDueDate,
                        BN.from(0),
                        borrowAmount,
                        expectedNewCR,
                        expectedNewDD,
                    );

                    // Any further attempt to make principal payment will be rejected since the
                    // credit line is closed.
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "creditLineNotInStateForMakingPrincipalPayment",
                    );
                });

                it("Should not allow payment when the protocol is paused or pool is not on", async function () {
                    await humaConfigContract.connect(protocolOwner).pause();
                    await expect(
                        creditContract.makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                    await humaConfigContract.connect(protocolOwner).unpause();

                    await poolContract.connect(poolOwner).disablePool();
                    await expect(
                        creditContract.makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                    await poolContract.connect(poolOwner).enablePool();
                });

                it("Should not allow non-borrower or non-PDS service account to make principal payment", async function () {
                    await expect(
                        creditContract
                            .connect(borrower2)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "paymentDetectionServiceAccountRequired",
                    );
                });

                it("Should not allow the borrower to make principal payment with 0 amount", async function () {
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), 0),
                    ).to.be.revertedWithCustomError(creditContract, "zeroAmountProvided");
                });

                it("Should not allow the borrower to pay for the principal if the bill is delayed", async function () {
                    makePaymentDate = drawdownDate.add(2, "months");
                    await setNextBlockTimestamp(makePaymentDate.unix());
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "creditLineNotInStateForMakingPrincipalPayment",
                    );
                });

                it("Should not allow the borrower to pay for the principal if the bill is defaulted", async function () {
                    const defaultGracePeriodInMonths = 1;
                    await poolConfigContract
                        .connect(poolOwner)
                        .setPoolDefaultGracePeriod(defaultGracePeriodInMonths);

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    // +2 because some months have more than 30 days.
                    const triggerDefaultDate =
                        oldCR.nextDueDate.toNumber() +
                        (defaultGracePeriodInMonths * CONSTANTS.DAYS_IN_A_MONTH + 2) *
                            CONSTANTS.SECONDS_IN_A_DAY;
                    await setNextBlockTimestamp(triggerDefaultDate);
                    await creditManagerContract
                        .connect(eaServiceAccount)
                        .triggerDefault(borrower.getAddress());
                    const expectedCR = await creditContract.getCreditRecord(creditHash);
                    expect(expectedCR.state).to.equal(CreditState.Defaulted);
                    const expectedDD = await creditContract.getDueDetail(creditHash);

                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "creditLineNotInStateForMakingPrincipalPayment",
                    );
                    const actualCR = await creditContract.getCreditRecord(creditHash);
                    checkCreditRecordsMatch(actualCR, expectedCR);
                    const actualDD = await creditContract.getDueDetail(creditHash);
                    checkDueDetailsMatch(actualDD, expectedDD);
                });
            });

            describe("When principal rate is non-zero", function () {
                async function prepareForMakePayment() {
                    principalRateInBps = 200;
                    await poolConfigContract.connect(poolOwner).setFeeStructure({
                        yieldInBps,
                        minPrincipalRateInBps: principalRateInBps,
                        lateFeeBps,
                    });
                    await approveCredit();
                    await drawdown();
                }

                beforeEach(async function () {
                    await loadFixture(prepareForMakePayment);
                });

                it("Should allow the borrower to pay for all principal once in the current billing cycle", async function () {
                    const cc = await creditManagerContract.getCreditConfig(creditHash);
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (
                            await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            )
                        ).toNumber() * 1000,
                    );

                    makePaymentDate = drawdownDate
                        .clone()
                        .add(2, "days")
                        .add(22, "hours")
                        .add(14, "seconds");
                    const nextDueDate = firstDueDate;
                    const [, , principalNextDue] = await calcPrincipalDueNew(
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        maturityDate,
                        latePaymentGracePeriodInDays,
                        principalRateInBps,
                    );
                    const expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue.sub(principalNextDue),
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        makePaymentDate,
                        borrowAmount,
                        borrowAmount,
                        nextDueDate,
                        principalNextDue,
                        borrowAmount.sub(principalNextDue),
                        expectedNewCR,
                        dd,
                    );
                });

                it("Should allow the borrower to make multiple principal payments within the same period", async function () {
                    const cc = await creditManagerContract.getCreditConfig(creditHash);
                    const cr = await creditContract.getCreditRecord(creditHash);
                    const dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (
                            await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            )
                        ).toNumber() * 1000,
                    );

                    // First payment pays off principal next due in the current billing cycle.
                    makePaymentDate = drawdownDate
                        .clone()
                        .add(2, "days")
                        .add(22, "hours")
                        .add(14, "seconds");
                    const nextDueDate = firstDueDate;
                    const [unbilledPrincipal, , principalNextDue] = await calcPrincipalDueNew(
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        maturityDate,
                        latePaymentGracePeriodInDays,
                        principalRateInBps,
                    );
                    const firstPaymentAmount = principalNextDue;
                    let expectedNewCR = {
                        unbilledPrincipal: cr.unbilledPrincipal,
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue.sub(principalNextDue),
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        makePaymentDate,
                        firstPaymentAmount,
                        firstPaymentAmount,
                        firstDueDate,
                        principalNextDue,
                        BN.from(0),
                        expectedNewCR,
                        dd,
                    );

                    // Second payment pays off the unbilled principal.
                    const secondPaymentDate = makePaymentDate.clone().add(1, "day");
                    // Attempt to pay the entire borrow amount, but only unbilled principal should be charged.
                    const secondPaymentAmount = borrowAmount;
                    expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: cr.nextDue.sub(principalNextDue),
                        yieldDue: cr.yieldDue,
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: cr.remainingPeriods,
                        state: CreditState.GoodStanding,
                    };
                    await testMakePrincipalPayment(
                        secondPaymentDate,
                        secondPaymentAmount,
                        unbilledPrincipal,
                        nextDueDate,
                        BN.from(0),
                        unbilledPrincipal,
                        expectedNewCR,
                        dd,
                    );
                });

                it("Should allow the borrower to payoff the principal in the last period and close the credit line", async function () {
                    const cc = await creditManagerContract.getCreditConfig(creditHash);
                    let cr = await creditContract.getCreditRecord(creditHash);
                    let dd = await creditContract.getDueDetail(creditHash);
                    const maturityDate = moment.utc(
                        (
                            await calendarContract.getMaturityDate(
                                cc.periodDuration,
                                cc.numOfPeriods,
                                drawdownDate.unix(),
                            )
                        ).toNumber() * 1000,
                    );

                    // First payment pays off the all past due and next due.
                    makePaymentDate = drawdownDate.clone().add(remainingPeriods - 1, "months");
                    const [yieldPastDue, yieldNextDue] = await calcYieldDueNew(
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        maturityDate,
                        latePaymentGracePeriodInDays,
                    );
                    let [unbilledPrincipal, principalPastDue, principalNextDue] =
                        await calcPrincipalDueNew(
                            calendarContract,
                            cc,
                            cr,
                            dd,
                            makePaymentDate,
                            maturityDate,
                            latePaymentGracePeriodInDays,
                            principalRateInBps,
                        );
                    const [, lateFee] = await calcLateFeeNew(
                        poolConfigContract,
                        calendarContract,
                        cc,
                        cr,
                        dd,
                        makePaymentDate,
                        latePaymentGracePeriodInDays,
                    );
                    await setNextBlockTimestamp(makePaymentDate.unix());
                    await creditContract
                        .connect(borrower)
                        .makePayment(
                            borrower.getAddress(),
                            yieldPastDue
                                .add(principalPastDue)
                                .add(lateFee)
                                .add(yieldNextDue)
                                .add(principalNextDue),
                        );

                    // Second payment pays off the principal due and closes the credit line.
                    const secondPaymentDate = makePaymentDate.clone().add(1, "day");
                    const nextDueDate = maturityDate;
                    const secondPaymentAmount = unbilledPrincipal;
                    dd = await creditContract.getDueDetail(creditHash);
                    let expectedNewCR = {
                        unbilledPrincipal: BN.from(0),
                        nextDueDate: nextDueDate.unix(),
                        nextDue: BN.from(0),
                        yieldDue: BN.from(0),
                        totalPastDue: BN.from(0),
                        missedPeriods: 0,
                        remainingPeriods: 0,
                        state: CreditState.Deleted,
                    };
                    await testMakePrincipalPayment(
                        secondPaymentDate,
                        secondPaymentAmount,
                        secondPaymentAmount,
                        nextDueDate,
                        BN.from(0),
                        unbilledPrincipal,
                        expectedNewCR,
                        dd,
                    );
                    // Further payment attempts will be rejected.
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "creditLineNotInStateForMakingPrincipalPayment",
                    );
                });

                it("Should not allow the borrower to pay for the principal if the bill is not in good standing state", async function () {
                    makePaymentDate = drawdownDate.add(2, "months");
                    await setNextBlockTimestamp(makePaymentDate.unix());
                    await expect(
                        creditContract
                            .connect(borrower)
                            .makePrincipalPayment(borrower.getAddress(), toToken(1)),
                    ).to.be.revertedWithCustomError(
                        creditContract,
                        "creditLineNotInStateForMakingPrincipalPayment",
                    );
                });
            });
        });
    });

    describe("triggerDefault", function () {
        const defaultGracePeriodInMonths = 2;
        const numOfPeriods = 6,
            yieldInBps = 1217,
            lateFeeBps = 100;
        let creditHash: string;
        let borrowAmount: BN;

        async function prepare() {
            borrowAmount = toToken(10_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            await poolConfigContract
                .connect(poolOwner)
                .setPoolDefaultGracePeriod(defaultGracePeriodInMonths);
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: 50,
                lateFeeBps,
            });
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    numOfPeriods,
                    yieldInBps,
                    toToken(0),
                    0,
                    true,
                );
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        async function testTriggerDefault(drawdownDate: number) {
            await setNextBlockTimestamp(drawdownDate);
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            const oldCR = await creditContract.getCreditRecord(creditHash);
            const defaultDate =
                oldCR.nextDueDate.toNumber() +
                (defaultGracePeriodInMonths * CONSTANTS.DAYS_IN_A_MONTH + 2) *
                    CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(defaultDate);

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            const expectedPrincipalLoss = borrowAmount;
            const startOfDefaultPeriod = await calendarContract.getStartDateOfPeriod(
                cc.periodDuration,
                defaultDate,
            );
            const daysPassed = await calendarContract.getDaysDiff(
                oldCR.nextDueDate,
                startOfDefaultPeriod,
            );
            const expectedAdditionalYieldPastDue = calcYield(
                borrowAmount,
                yieldInBps,
                daysPassed.toNumber(),
            );
            const expectedYieldDue = calcYield(
                borrowAmount,
                yieldInBps,
                CONSTANTS.DAYS_IN_A_MONTH,
            );
            const expectedYieldLoss = oldCR.yieldDue
                .add(expectedAdditionalYieldPastDue)
                .add(expectedYieldDue);
            // Late fee starts to accrue since the beginning of the second billing cycle until the start of tomorrow.
            const lateFeeDays =
                (await calendarContract.getDaysDiff(oldCR.nextDueDate, defaultDate)).toNumber() +
                1;
            const expectedFeesLoss = await calcYield(borrowAmount, lateFeeBps, lateFeeDays);
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .triggerDefault(borrower.getAddress()),
            )
                .to.emit(creditManagerContract, "DefaultTriggered")
                .withArgs(
                    creditHash,
                    expectedPrincipalLoss,
                    expectedYieldLoss,
                    expectedFeesLoss,
                    await eaServiceAccount.getAddress(),
                )
                .to.emit(creditContract, "BillRefreshed")
                .to.emit(poolContract, "ProfitDistributed")
                .to.emit(poolContract, "LossDistributed");

            const cr = await creditContract.getCreditRecord(creditHash);
            expect(cr.state).to.equal(CreditState.Defaulted);

            // Any further attempt to trigger default is disallowed.
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .triggerDefault(borrower.getAddress()),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "defaultHasAlreadyBeenTriggered",
            );
        }

        describe("If drawdown happens at the beginning of a full period", function () {
            it("Should allow default to be triggered once", async function () {
                const currentTS = (await getLatestBlock()).timestamp;
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const drawdownDate = await calendarContract.getStartDateOfNextPeriod(
                    cc.periodDuration,
                    currentTS,
                );
                await testTriggerDefault(drawdownDate.toNumber());
            });
        });

        describe("If drawdown happens in the middle of a full period", function () {
            it("Should allow default to be triggered once", async function () {
                const currentTS = (await getLatestBlock()).timestamp;
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const drawdownDate = (
                    await calendarContract.getStartDateOfNextPeriod(cc.periodDuration, currentTS)
                ).add(CONSTANTS.SECONDS_IN_A_DAY * 5);
                await testTriggerDefault(drawdownDate.toNumber());
            });
        });

        it("Should not allow default to be triggered when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract.connect(eaServiceAccount).triggerDefault(borrower.address),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract.connect(eaServiceAccount).triggerDefault(borrower.address),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
        });

        it("Should not allow non-EA service account to trigger default", async function () {
            await expect(
                creditManagerContract.triggerDefault(borrower.address),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "evaluationAgentServiceAccountRequired",
            );
        });

        it("Should not allow default to be triggered if the default grace period hasn't passed", async function () {
            await creditContract.connect(borrower).drawdown(borrower.address, borrowAmount);

            const drawdownDate = (await getLatestBlock()).timestamp;
            const defaultDate =
                drawdownDate + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
            await setNextBlockTimestamp(defaultDate);

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .triggerDefault(borrower.getAddress()),
            ).to.be.revertedWithCustomError(creditManagerContract, "defaultTriggeredTooEarly");
        });
    });

    describe("closeCredit", function () {
        describe("When the credit is not approved yet", function () {
            it("Should not be able to close a non-existent credit", async function () {
                await expect(
                    creditManagerContract.connect(borrower).closeCredit(borrower.getAddress()),
                ).to.be.revertedWithCustomError(creditManagerContract, "notBorrower");
            });

            it("Should not allow closure when the protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditManagerContract.connect(borrower).closeCredit(borrower.getAddress()),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditManagerContract.connect(borrower).closeCredit(borrower.getAddress()),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });
        });

        describe("When the credit has been approved", function () {
            let creditHash: string;

            async function approveCredit(
                remainingPeriods: number = 1,
                committedAmount: BN = BN.from(0),
            ) {
                creditHash = await borrowerLevelCreditHash(creditContract, borrower);
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.address,
                        toToken(100_000),
                        remainingPeriods,
                        1_000,
                        committedAmount,
                        0,
                        true,
                    );
            }

            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            async function testCloseCredit(actor: SignerWithAddress) {
                await expect(
                    creditManagerContract.connect(actor).closeCredit(borrower.getAddress()),
                )
                    .to.emit(creditManagerContract, "CreditClosed")
                    .withArgs(
                        creditHash,
                        CreditClosureReason.AdminClosure,
                        await actor.getAddress(),
                    );

                // Make sure relevant fields have been reset.
                const cr = await creditContract.getCreditRecord(creditHash);
                expect(cr.state).to.equal(CreditState.Deleted);
                expect(cr.remainingPeriods).to.equal(ethers.constants.Zero);
                const creditConfig = await creditManagerContract.getCreditConfig(creditHash);
                expect(creditConfig.creditLimit).to.equal(ethers.constants.Zero);
            }

            async function testCloseCreditReversion(actor: SignerWithAddress, errorName: string) {
                const oldCreditConfig = await creditManagerContract.getCreditConfig(creditHash);
                const oldCreditRecord = await creditContract.getCreditRecord(creditHash);
                await expect(
                    creditManagerContract.connect(actor).closeCredit(borrower.getAddress()),
                ).to.be.revertedWithCustomError(creditManagerContract, errorName);

                // Make sure neither the credit config nor the credit record has changed.
                const newCreditConfig = await creditManagerContract.getCreditConfig(creditHash);
                checkCreditConfig(
                    newCreditConfig,
                    oldCreditConfig.creditLimit,
                    oldCreditConfig.committedAmount,
                    oldCreditConfig.periodDuration,
                    oldCreditConfig.numOfPeriods,
                    oldCreditConfig.yieldInBps,
                    oldCreditConfig.revolving,
                    oldCreditConfig.advanceRateInBps,
                    oldCreditConfig.autoApproval,
                );
                const newCreditRecord = await creditContract.getCreditRecord(creditHash);
                checkCreditRecord(
                    newCreditRecord,
                    oldCreditRecord.unbilledPrincipal,
                    oldCreditRecord.nextDueDate,
                    oldCreditRecord.nextDue,
                    oldCreditRecord.yieldDue,
                    oldCreditRecord.totalPastDue,
                    oldCreditRecord.missedPeriods,
                    oldCreditRecord.remainingPeriods,
                    oldCreditRecord.state,
                );
            }

            it("Should allow the borrower to close a newly approved credit", async function () {
                await testCloseCredit(borrower);
            });

            it("Should allow the evaluation agent to close a newly approved credit", async function () {
                await testCloseCredit(eaServiceAccount);
            });

            it("Should allow the borrower to close a credit that's fully paid back", async function () {
                const amount = toToken(1_000);
                await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                const cr = await creditContract.getCreditRecord(creditHash);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), cr.nextDue.add(cr.unbilledPrincipal));
                await testCloseCredit(borrower);
            });

            it("Should allow the borrower to close a credit that has commitment but has reached maturity", async function () {
                // Close the approved credit then open a new one with a different committed amount.
                await creditManagerContract.connect(borrower).closeCredit(borrower.getAddress());
                await approveCredit(1, toToken(100_000));
                // Make one round of drawdown so that the borrower have a credit record, and then pay off the credit.
                const amount = toToken(1_000);
                await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                const cr = await creditContract.getCreditRecord(creditHash);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), amount.add(cr.nextDue));
                await testCloseCredit(borrower);
            });

            it("Should not allow the borrower to close a newly approved credit that has unfulfilled commitment", async function () {
                // Close the approved credit then open a new one with a different committed amount.
                await creditManagerContract.connect(borrower).closeCredit(borrower.getAddress());
                await approveCredit(3, toToken(100_000));
                await testCloseCredit(borrower);
            });

            it("Should not allow the borrower to close a credit that has upcoming yield due", async function () {
                const amount = toToken(1_000);
                await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                // Only pay back the total principal outstanding.
                const cr = await creditContract.getCreditRecord(creditHash);
                const totalPrincipal = cr.nextDue.sub(cr.yieldDue).add(cr.unbilledPrincipal);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), totalPrincipal);
                await testCloseCreditReversion(borrower, "creditLineHasOutstandingBalance");
            });

            it("Should not allow the borrower to close a credit that has past due", async function () {
                const amount = toToken(1_000);
                await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                const poolSettings = await poolConfigContract.getPoolSettings();

                // Advance the clock so that all due becomes past due.
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                const currentBlockTimestamp = (await getLatestBlock()).timestamp;
                const nextBlockTimestamp =
                    (
                        await calendarContract.getStartDateOfNextPeriod(
                            cc.periodDuration,
                            currentBlockTimestamp,
                        )
                    ).toNumber() +
                    poolSettings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                    100;
                await setNextBlockTimestamp(nextBlockTimestamp);
                await creditManagerContract.refreshCredit(borrower.getAddress());
                const cr = await creditContract.getCreditRecord(creditHash);
                expect(cr.nextDue).to.equal(ethers.constants.Zero);
                expect(cr.totalPastDue).to.be.greaterThan(ethers.constants.Zero);
                expect(cr.unbilledPrincipal).to.equal(ethers.constants.Zero);
                await testCloseCreditReversion(borrower, "creditLineHasOutstandingBalance");
            });

            it("Should not allow the borrower to close a credit that has outstanding unbilled principal", async function () {
                const amount = toToken(1_000);
                await creditContract.connect(borrower).drawdown(borrower.getAddress(), amount);
                // Only pay back the next due and have unbilled principal outstanding.
                const cr = await creditContract.getCreditRecord(creditHash);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), cr.nextDue);
                await testCloseCreditReversion(borrower, "creditLineHasOutstandingBalance");
            });

            it("Should not allow the borrower to close a used credit that has unfulfilled commitment", async function () {
                // Close the approved credit then open a new one with a different committed amount.
                await creditManagerContract.connect(borrower).closeCredit(borrower.getAddress());
                await approveCredit(3, toToken(100_000));
                await creditContract
                    .connect(borrower)
                    .drawdown(borrower.getAddress(), toToken(10_000));
                const cr = await creditContract.getCreditRecord(creditHash);
                await creditContract
                    .connect(borrower)
                    .makePayment(borrower.getAddress(), cr.nextDue.add(cr.unbilledPrincipal));
                await testCloseCreditReversion(borrower, "creditLineHasUnfulfilledCommitment");
            });
        });
    });

    describe("pauseCredit and unpauseCredit", function () {
        let creditHash: string;

        async function approveCredit() {
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    1,
                    1_000,
                    toToken(0),
                    0,
                    true,
                );
        }

        beforeEach(async function () {
            await loadFixture(approveCredit);
        });

        it("Should allow the EA to pause and unpause a credit", async function () {
            await creditContract.connect(borrower).drawdown(borrower.getAddress(), toToken(1_000));
            await creditManagerContract
                .connect(eaServiceAccount)
                .pauseCredit(borrower.getAddress());
            let cr = await creditContract.getCreditRecord(creditHash);
            expect(cr.state).to.equal(CreditState.Paused);

            await creditManagerContract
                .connect(eaServiceAccount)
                .unpauseCredit(borrower.getAddress());
            cr = await creditContract.getCreditRecord(creditHash);
            expect(cr.state).to.equal(CreditState.GoodStanding);
        });

        it("Should do nothing if the credit line is not in the desired states", async function () {
            const oldCR = await creditContract.getCreditRecord(creditHash);
            await creditManagerContract
                .connect(eaServiceAccount)
                .pauseCredit(borrower.getAddress());
            let newCR = await creditContract.getCreditRecord(creditHash);
            expect(newCR.state).to.equal(oldCR.state);

            await creditManagerContract
                .connect(eaServiceAccount)
                .unpauseCredit(borrower.getAddress());
            newCR = await creditContract.getCreditRecord(creditHash);
            expect(newCR.state).to.equal(oldCR.state);
        });

        it("Should not allow the credit to be paused/unpaused when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract.connect(eaServiceAccount).pauseCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract.connect(eaServiceAccount).pauseCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-EA to pause or unpause the credit", async function () {
            await creditContract.connect(borrower).drawdown(borrower.getAddress(), toToken(1_000));
            const oldCR = await creditContract.getCreditRecord(creditHash);
            await expect(
                creditManagerContract.connect(borrower).pauseCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "evaluationAgentServiceAccountRequired",
            );
            let newCR = await creditContract.getCreditRecord(creditHash);
            expect(newCR.state).to.equal(oldCR.state);

            await expect(
                creditManagerContract.connect(borrower).unpauseCredit(borrower.getAddress()),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "evaluationAgentServiceAccountRequired",
            );
            newCR = await creditContract.getCreditRecord(creditHash);
            expect(newCR.state).to.equal(oldCR.state);
        });
    });

    describe("extendRemainingPeriod", function () {
        let creditHash: string;
        const numOfPeriods = 2;

        async function approveCredit() {
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    1,
                    1_000,
                    toToken(0),
                    0,
                    true,
                );
        }

        beforeEach(async function () {
            await loadFixture(approveCredit);
        });

        it("Should allow the EA to extend the remaining periods of a credit line", async function () {
            await creditContract.connect(borrower).drawdown(borrower.address, toToken(5_000));

            const oldCR = await creditContract.getCreditRecord(creditHash);
            const newRemainingPeriods = oldCR.remainingPeriods + numOfPeriods;
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(borrower.getAddress(), numOfPeriods),
            )
                .to.emit(creditManagerContract, "RemainingPeriodsExtended")
                .withArgs(
                    creditHash,
                    oldCR.remainingPeriods,
                    newRemainingPeriods,
                    await eaServiceAccount.getAddress(),
                );
            const newCR = await creditContract.getCreditRecord(creditHash);
            expect(newCR.remainingPeriods).to.equal(newRemainingPeriods);
        });

        it("Should not allow extension when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(borrower.getAddress(), numOfPeriods),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(borrower.getAddress(), numOfPeriods),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-EAs to extend the remaining period", async function () {
            await expect(
                creditManagerContract
                    .connect(borrower)
                    .extendRemainingPeriod(borrower.getAddress(), numOfPeriods),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "evaluationAgentServiceAccountRequired",
            );
        });

        it("Should not allow extension on a newly approved credit line", async function () {
            const oldCR = await creditContract.getCreditRecord(creditHash);
            expect(oldCR.state).to.equal(CreditState.Approved);

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(borrower.getAddress(), 1),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "creditLineNotInStateForUpdate",
            );
        });

        it("Should not allow extension on a delayed credit line", async function () {
            await creditContract.connect(borrower).drawdown(borrower.address, toToken(5_000));

            const oldCR = await creditContract.getCreditRecord(creditHash);
            const settings = await poolConfigContract.getPoolSettings();
            const latePaymentDeadline =
                oldCR.nextDueDate.toNumber() +
                settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY;
            const nextTime = latePaymentDeadline + 100;
            await setNextBlockTimestamp(nextTime);

            await creditManagerContract.refreshCredit(borrower.getAddress());
            const newCR = await creditContract.getCreditRecord(creditHash);
            expect(newCR.state).to.equal(CreditState.Delayed);

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(borrower.getAddress(), 1),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "creditLineNotInStateForUpdate",
            );
        });

        it("Should not allow extension on a defaulted credit line", async function () {
            await creditContract.connect(borrower).drawdown(borrower.address, toToken(5_000));

            const oldCR = await creditContract.getCreditRecord(creditHash);
            const settings = await poolConfigContract.getPoolSettings();
            const refreshDate =
                oldCR.nextDueDate.toNumber() +
                (settings.defaultGracePeriodInMonths + 1) *
                    CONSTANTS.DAYS_IN_A_MONTH *
                    CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(refreshDate);
            await creditManagerContract.refreshCredit(borrower.getAddress());
            await creditManagerContract
                .connect(eaServiceAccount)
                .triggerDefault(borrower.getAddress());
            const newCR = await creditContract.getCreditRecord(creditHash);
            expect(newCR.state).to.equal(CreditState.Defaulted);

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(borrower.getAddress(), 1),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "creditLineNotInStateForUpdate",
            );
        });
    });

    describe("updateYield", function () {
        const yieldInBps = 1317;
        let borrowAmount: BN, committedAmount: BN, newYieldInBps: number;
        let drawdownDate: number;
        let creditHash: string;

        async function approveCredit() {
            borrowAmount = toToken(50_000);
            committedAmount = toToken(40_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    await borrower.getAddress(),
                    toToken(100_000),
                    1,
                    yieldInBps,
                    committedAmount,
                    0,
                    true,
                );
        }

        beforeEach(async function () {
            await loadFixture(approveCredit);
        });
        async function drawdown() {
            drawdownDate = (await calendarContract.getStartOfNextMonth()).toNumber();
            await setNextBlockTimestamp(drawdownDate);
            await creditContract.connect(borrower).drawdown(borrower.getAddress(), borrowAmount);
        }

        async function makePayment(paymentAmount: BN) {
            const paymentDate = drawdownDate + 600;
            await setNextBlockTimestamp(paymentDate);
            await creditContract
                .connect(borrower)
                .makePayment(borrower.getAddress(), paymentAmount);
        }

        async function testUpdate(
            oldYieldDue: BN,
            newYieldDue: BN,
            expectedNextDue: BN,
            expectedYieldDue: BN,
        ) {
            const updateDate: number = drawdownDate + CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(updateDate);
            const oldCR = await creditContract.getCreditRecord(creditHash);
            const oldDD = await creditContract.getDueDetail(creditHash);
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateYield(borrower.getAddress(), newYieldInBps),
            )
                .to.emit(creditManagerContract, "YieldUpdated")
                .withArgs(
                    creditHash,
                    yieldInBps,
                    newYieldInBps,
                    oldYieldDue,
                    (actualNewYieldDue: BN) =>
                        isCloseTo(actualNewYieldDue, newYieldDue, BN.from(1)),
                    await eaServiceAccount.getAddress(),
                );

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            expect(cc.yieldInBps).to.equal(newYieldInBps);
            const actualCR = await creditContract.getCreditRecord(creditHash);
            const expectedCR = {
                ...oldCR,
                ...{
                    nextDue: expectedNextDue,
                    yieldDue: expectedYieldDue,
                },
            };
            checkCreditRecordsMatch(actualCR, expectedCR, BN.from(1));
            const actualDD = await creditContract.getDueDetail(creditHash);
            const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2).add(
                calcYield(borrowAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
            );
            const expectedCommittedYield = calcYield(committedAmount, yieldInBps, 2).add(
                calcYield(committedAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
            );
            const expectedDD = {
                ...oldDD,
                ...{
                    accrued: expectedAccruedYield,
                    committed: expectedCommittedYield,
                },
            };
            checkDueDetailsMatch(actualDD, expectedDD, BN.from(1));
        }

        describe("If the yield is updated to a higher value", function () {
            beforeEach(async function () {
                newYieldInBps = 1517;
            });

            describe("If the yield hasn't been paid yet", function () {
                it("Should update the yield due", async function () {
                    await drawdown();

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2).add(
                        calcYield(borrowAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
                    );
                    await testUpdate(
                        oldDD.accrued,
                        expectedAccruedYield,
                        oldCR.nextDue.sub(oldCR.yieldDue).add(expectedAccruedYield),
                        expectedAccruedYield,
                    );
                });

                it("Should allow more than one update within a period", async function () {
                    await drawdown();

                    // First update.
                    const firstYieldInBps = 1517;
                    const firstUpdateDate = drawdownDate + CONSTANTS.SECONDS_IN_A_DAY;
                    await setNextBlockTimestamp(firstUpdateDate);
                    await creditManagerContract
                        .connect(eaServiceAccount)
                        .updateYield(borrower.getAddress(), firstYieldInBps);

                    // Second update.
                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    const secondYieldInBps = 1717;
                    const secondUpdateDate = firstUpdateDate + 12 * CONSTANTS.SECONDS_IN_A_DAY;
                    await setNextBlockTimestamp(secondUpdateDate);
                    const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2)
                        .add(calcYield(borrowAmount, firstYieldInBps, 12))
                        .add(calcYield(borrowAmount, secondYieldInBps, 16));
                    await expect(
                        creditManagerContract
                            .connect(eaServiceAccount)
                            .updateYield(borrower.getAddress(), secondYieldInBps),
                    )
                        .to.emit(creditManagerContract, "YieldUpdated")
                        .withArgs(
                            creditHash,
                            firstYieldInBps,
                            secondYieldInBps,
                            oldCR.yieldDue,
                            expectedAccruedYield,
                            await eaServiceAccount.getAddress(),
                        );

                    const cc = await creditManagerContract.getCreditConfig(creditHash);
                    expect(cc.yieldInBps).to.equal(secondYieldInBps);
                    const actualCR = await creditContract.getCreditRecord(creditHash);
                    const expectedCR = {
                        ...oldCR,
                        ...{
                            nextDue: oldCR.nextDue.sub(oldCR.yieldDue).add(expectedAccruedYield),
                            yieldDue: expectedAccruedYield,
                        },
                    };
                    checkCreditRecordsMatch(actualCR, expectedCR);
                    const actualDD = await creditContract.getDueDetail(creditHash);
                    const expectedCommittedYield = calcYield(committedAmount, yieldInBps, 2)
                        .add(calcYield(committedAmount, firstYieldInBps, 12))
                        .add(calcYield(committedAmount, secondYieldInBps, 16));
                    const expectedDD = {
                        ...oldDD,
                        ...{
                            accrued: expectedAccruedYield,
                            committed: expectedCommittedYield,
                        },
                    };
                    checkDueDetailsMatch(actualDD, expectedDD, BN.from(1));
                });
            });

            describe("If the yield has been partially paid", function () {
                it("Should update the yield due", async function () {
                    await drawdown();
                    // Make partial payment towards the yield due.
                    const yieldDue = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue.div(2));

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    expect(oldDD.paid).to.be.gt(0);
                    const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2).add(
                        calcYield(borrowAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
                    );
                    await testUpdate(
                        oldDD.accrued.sub(oldDD.paid),
                        expectedAccruedYield.sub(oldDD.paid),
                        oldCR.nextDue
                            .sub(oldCR.yieldDue)
                            .add(expectedAccruedYield)
                            .sub(oldDD.paid),
                        expectedAccruedYield.sub(oldDD.paid),
                    );
                });
            });

            describe("If the yield has been paid off", function () {
                it("Should update the yield due", async function () {
                    await drawdown();
                    // Make full payment towards the yield due.
                    const yieldDue = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue);

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    expect(oldDD.paid).to.equal(yieldDue);
                    const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2).add(
                        calcYield(borrowAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
                    );
                    await testUpdate(
                        toToken(0),
                        expectedAccruedYield.sub(oldDD.paid),
                        oldCR.nextDue
                            .sub(oldCR.yieldDue)
                            .add(expectedAccruedYield)
                            .sub(oldDD.paid),
                        expectedAccruedYield.sub(oldDD.paid),
                    );
                });
            });
        });

        describe("If the yield is updated to a lower value", function () {
            beforeEach(async function () {
                newYieldInBps = 1117;
            });

            describe("If the yield hasn't been paid yet", function () {
                it("Should update the yield due", async function () {
                    await drawdown();

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2).add(
                        calcYield(borrowAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
                    );
                    await testUpdate(
                        oldDD.accrued,
                        expectedAccruedYield,
                        oldCR.nextDue.sub(oldCR.yieldDue).add(expectedAccruedYield),
                        expectedAccruedYield,
                    );
                });
            });

            describe("If the yield has been partially paid", function () {
                it("Should update the yield due", async function () {
                    await drawdown();
                    // Make partial payment towards the yield due.
                    const yieldDue = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue.div(2));

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    expect(oldDD.paid).to.be.gt(0);
                    const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2).add(
                        calcYield(borrowAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
                    );
                    await testUpdate(
                        oldDD.accrued.sub(oldDD.paid),
                        expectedAccruedYield.sub(oldDD.paid),
                        oldCR.nextDue
                            .sub(oldCR.yieldDue)
                            .add(expectedAccruedYield)
                            .sub(oldDD.paid),
                        expectedAccruedYield.sub(oldDD.paid),
                    );
                });
            });

            describe("If the yield has been paid off", function () {
                it("Should update the yield due", async function () {
                    await drawdown();
                    // Make full payment towards the yield due.
                    const yieldDue = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue);

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    expect(oldDD.paid).to.equal(yieldDue);
                    const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2).add(
                        calcYield(borrowAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
                    );
                    await testUpdate(
                        oldDD.accrued.sub(oldDD.paid),
                        toToken(0),
                        toToken(0),
                        toToken(0),
                    );
                });
            });
        });

        it("Should not allow update when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateYield(await borrower.getAddress(), 1517),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateYield(await borrower.getAddress(), 1517),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-EAs to perform the update", async function () {
            await expect(
                creditManagerContract.updateYield(await borrower.getAddress(), 1517),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "evaluationAgentServiceAccountRequired",
            );
        });

        it("Should not allow the EA to update the yield if the credit is newly approved", async function () {
            const updateDate = (await calendarContract.getStartOfNextMonth()).toNumber();
            await setNextBlockTimestamp(updateDate);

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateYield(borrower.getAddress(), 1517),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "creditLineNotInStateForUpdate",
            );
        });
    });

    describe("updateLimitAndCommitment", function () {
        const yieldInBps = 1317;
        let creditLimit: BN, committedAmount: BN, borrowAmount: BN, newCommittedAmount: BN;
        let drawdownDate: number;
        let creditHash: string;

        async function approveCredit() {
            creditLimit = toToken(100_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    creditLimit,
                    1,
                    yieldInBps,
                    committedAmount,
                    0,
                    true,
                );
        }

        async function drawdown() {
            borrowAmount = toToken(50_000);
            drawdownDate = (await calendarContract.getStartOfNextMonth()).toNumber();
            await setNextBlockTimestamp(drawdownDate);
            await creditContract.connect(borrower).drawdown(borrower.getAddress(), borrowAmount);
        }

        async function makePayment(paymentAmount: BN) {
            const paymentDate = drawdownDate + 600;
            await setNextBlockTimestamp(paymentDate);
            await creditContract
                .connect(borrower)
                .makePayment(borrower.getAddress(), paymentAmount);
        }

        async function testUpdate(
            oldYieldDue: BN,
            newYieldDue: BN,
            expectedNextDue: BN,
            expectedYieldDue: BN,
        ) {
            const updateDate = drawdownDate + CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(updateDate);
            const oldCR = await creditContract.getCreditRecord(creditHash);
            const oldDD = await creditContract.getDueDetail(creditHash);
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateLimitAndCommitment(
                        borrower.getAddress(),
                        creditLimit,
                        newCommittedAmount,
                    ),
            )
                .to.emit(creditManagerContract, "LimitAndCommitmentUpdated")
                .withArgs(
                    creditHash,
                    creditLimit,
                    creditLimit,
                    committedAmount,
                    newCommittedAmount,
                    oldYieldDue,
                    newYieldDue,
                    await eaServiceAccount.getAddress(),
                );

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            expect(cc.creditLimit).to.equal(creditLimit);
            expect(cc.committedAmount).to.equal(newCommittedAmount);
            const actualCR = await creditContract.getCreditRecord(creditHash);
            const expectedCR = {
                ...oldCR,
                ...{
                    nextDue: expectedNextDue,
                    yieldDue: expectedYieldDue,
                },
            };
            checkCreditRecordsMatch(actualCR, expectedCR);
            const actualDD = await creditContract.getDueDetail(creditHash);
            const expectedCommittedYield = calcYield(committedAmount, yieldInBps, 2).add(
                calcYield(newCommittedAmount, yieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
            );
            const expectedDD = {
                ...oldDD,
                ...{
                    committed: expectedCommittedYield,
                },
            };
            checkDueDetailsMatch(actualDD, expectedDD);
        }

        describe("If the updated committed yield stays below the accrued yield", function () {
            beforeEach(async function () {
                committedAmount = toToken(0);
                newCommittedAmount = toToken(25_000);
                await loadFixture(approveCredit);
            });

            describe("If the yield hasn't been paid yet", function () {
                it("Should update the committed amount but not the yield due", async function () {
                    await drawdown();

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    await testUpdate(oldDD.accrued, oldDD.accrued, oldCR.nextDue, oldCR.yieldDue);
                });
            });

            describe("If the yield has been partially paid", function () {
                it("Should update the committed amount but not the yield due", async function () {
                    await drawdown();
                    // Make partial payment towards the yield due.
                    const yieldDue = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue.div(2));

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    expect(oldDD.paid).to.be.gt(0);
                    await testUpdate(
                        oldDD.accrued.sub(oldDD.paid),
                        oldDD.accrued.sub(oldDD.paid),
                        oldCR.nextDue,
                        oldCR.yieldDue,
                    );
                });
            });

            describe("If the yield has been paid off", function () {
                it("Should update the committed amount but not the yield due", async function () {
                    await drawdown();
                    // Make full payment towards the yield due.
                    const yieldDue = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue);

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    expect(oldDD.paid).to.equal(yieldDue);
                    await testUpdate(toToken(0), toToken(0), oldCR.nextDue, oldCR.yieldDue);
                });
            });
        });

        describe("If the updated committed yield becomes higher than the accrued yield", function () {
            beforeEach(async function () {
                committedAmount = toToken(0);
                newCommittedAmount = toToken(75_000);
                await loadFixture(approveCredit);
            });

            describe("If the yield hasn't been paid yet", function () {
                it("Should update the committed amount and the yield due", async function () {
                    await drawdown();

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    const expectedCommittedYield = calcYield(
                        newCommittedAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH - 2,
                    );
                    await testUpdate(
                        oldDD.accrued,
                        expectedCommittedYield,
                        oldCR.nextDue.sub(oldCR.yieldDue).add(expectedCommittedYield),
                        expectedCommittedYield,
                    );
                });
            });

            describe("If the yield has been partially paid", function () {
                it("Should update the committed amount and the yield due", async function () {
                    await drawdown();
                    // Make partial payment towards the yield due.
                    const yieldDue = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue.div(2));

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    const expectedCommittedYield = calcYield(
                        newCommittedAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH - 2,
                    );
                    expect(oldDD.paid).to.be.gt(0);
                    await testUpdate(
                        oldDD.accrued.sub(oldDD.paid),
                        expectedCommittedYield.sub(oldDD.paid),
                        oldCR.nextDue
                            .sub(oldCR.yieldDue)
                            .add(expectedCommittedYield)
                            .sub(oldDD.paid),
                        expectedCommittedYield.sub(oldDD.paid),
                    );
                });
            });

            describe("If the yield has been paid off", function () {
                it("Should update the committed amount and the yield due", async function () {
                    await drawdown();
                    // Make full payment towards the yield due.
                    const yieldDue = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue);

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    const expectedCommittedYield = calcYield(
                        newCommittedAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH - 2,
                    );
                    expect(oldDD.paid).to.equal(yieldDue);
                    await testUpdate(
                        toToken(0),
                        expectedCommittedYield.sub(oldDD.paid),
                        oldCR.nextDue
                            .sub(oldCR.yieldDue)
                            .add(expectedCommittedYield)
                            .sub(oldDD.paid),
                        expectedCommittedYield.sub(oldDD.paid),
                    );
                });
            });
        });

        describe("If the updated committed yield becomes lower than the accrued yield", function () {
            beforeEach(async function () {
                committedAmount = toToken(75_000);
                newCommittedAmount = toToken(25_000);
                await loadFixture(approveCredit);
            });

            describe("If the yield hasn't been paid yet", function () {
                it("Should update the committed amount and the yield due", async function () {
                    await drawdown();

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    const expectedAccruedYield = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    await testUpdate(
                        oldDD.committed,
                        expectedAccruedYield,
                        oldCR.nextDue.sub(oldCR.yieldDue).add(expectedAccruedYield),
                        expectedAccruedYield,
                    );
                });
            });

            describe("If the yield has been partially paid", function () {
                it("Should update the committed amount and the yield due", async function () {
                    await drawdown();
                    // Make partial payment towards the yield due.
                    const yieldDue = calcYield(
                        committedAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue.div(2));

                    const oldCR = await creditContract.getCreditRecord(creditHash);
                    const oldDD = await creditContract.getDueDetail(creditHash);
                    const expectedAccruedYield = calcYield(
                        borrowAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(oldDD.paid).to.be.gt(0);
                    await testUpdate(
                        oldDD.committed.sub(oldDD.paid),
                        expectedAccruedYield.sub(oldDD.paid),
                        oldCR.nextDue
                            .sub(oldCR.yieldDue)
                            .add(expectedAccruedYield)
                            .sub(oldDD.paid),
                        expectedAccruedYield.sub(oldDD.paid),
                    );
                });
            });

            describe("If the yield has been paid off", function () {
                it("Should update the committed amount and the yield due", async function () {
                    await drawdown();
                    // Make full payment towards the yield due.
                    const yieldDue = calcYield(
                        committedAmount,
                        yieldInBps,
                        CONSTANTS.DAYS_IN_A_MONTH,
                    );
                    expect(yieldDue).to.be.gt(0);
                    await makePayment(yieldDue);

                    const oldDD = await creditContract.getDueDetail(creditHash);
                    expect(oldDD.paid).to.equal(yieldDue);
                    await testUpdate(toToken(0), toToken(0), toToken(0), toToken(0));
                });
            });
        });

        it("Should not allow update when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateLimitAndCommitment(
                        await borrower.getAddress(),
                        toToken(200_000),
                        toToken(100_000),
                    ),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateLimitAndCommitment(
                        await borrower.getAddress(),
                        toToken(200_000),
                        toToken(100_000),
                    ),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-EAs to perform the update", async function () {
            await expect(
                creditManagerContract.updateLimitAndCommitment(
                    await borrower.getAddress(),
                    toToken(200_000),
                    toToken(100_000),
                ),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "evaluationAgentServiceAccountRequired",
            );
        });

        it("Should not allow the updated committed amount to exceed the credit limit", async function () {
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateLimitAndCommitment(
                        await borrower.getAddress(),
                        toToken(100_000),
                        toToken(200_000),
                    ),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "committedAmountGreaterThanCreditLimit",
            );
        });

        it("Should not allow the EA to update the credit limit and commitment if the credit is newly approved", async function () {
            const updateDate = (await calendarContract.getStartOfNextMonth()).toNumber();
            await setNextBlockTimestamp(updateDate);

            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateLimitAndCommitment(
                        await borrower.getAddress(),
                        toToken(200_000),
                        toToken(100_000),
                    ),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "creditLineNotInStateForUpdate",
            );
        });
    });

    describe("waiveLateFee", function () {
        let drawdownDate: number;
        const lateFeeBps = 300,
            latePaymentGracePeriodInDays = 5,
            yieldInBps = 1317;
        let borrowAmount: BN;
        let creditHash: string;

        async function approveCredit() {
            await poolConfigContract
                .connect(poolOwner)
                .setLatePaymentGracePeriodInDays(latePaymentGracePeriodInDays);
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: 50,
                lateFeeBps,
            });

            borrowAmount = toToken(50_000);
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(100_000),
                    1,
                    yieldInBps,
                    toToken(0),
                    0,
                    true,
                );
        }

        async function drawDownAndRefresh() {
            drawdownDate = (await calendarContract.getStartOfNextMonth()).toNumber();
            await setNextBlockTimestamp(drawdownDate);
            await creditContract.connect(borrower).drawdown(borrower.getAddress(), borrowAmount);

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            const refreshDate =
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        cc.periodDuration,
                        drawdownDate,
                    )
                ).toNumber() +
                latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                600;
            await setNextBlockTimestamp(refreshDate);
            await creditManagerContract.refreshCredit(borrower.getAddress());
        }

        describe("With newly approved credit", function () {
            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            it("Should not allow the EA to waive late", async function () {
                const updateDate = (await calendarContract.getStartOfNextMonth()).toNumber();
                await setNextBlockTimestamp(updateDate);

                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .waiveLateFee(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(
                    creditManagerContract,
                    "creditLineNotInStateForUpdate",
                );
            });
        });

        describe("After the credit is delayed", function () {
            async function prepare() {
                await approveCredit();
                await drawDownAndRefresh();
            }

            beforeEach(async function () {
                await loadFixture(prepare);
            });

            async function testWaiveLateFee(waivedAmount: BN, expectedNewLateFee: BN) {
                const oldCR = await creditContract.getCreditRecord(creditHash);
                expect(oldCR.totalPastDue).to.be.gt(0);
                const oldDD = await creditContract.getDueDetail(creditHash);
                expect(oldDD.lateFee).to.be.gt(0);
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .waiveLateFee(borrower.getAddress(), waivedAmount),
                )
                    .to.emit(creditManagerContract, "LateFeeWaived")
                    .withArgs(
                        creditHash,
                        oldDD.lateFee,
                        expectedNewLateFee,
                        await eaServiceAccount.getAddress(),
                    );

                const actualCR = await creditContract.getCreditRecord(creditHash);
                const expectedCR = {
                    ...oldCR,
                    ...{
                        totalPastDue: oldCR.totalPastDue
                            .sub(oldDD.lateFee)
                            .add(expectedNewLateFee),
                    },
                };
                checkCreditRecordsMatch(actualCR, expectedCR);
                const actualDD = await creditContract.getDueDetail(creditHash);
                const expectedDD = {
                    ...oldDD,
                    ...{
                        lateFee: expectedNewLateFee,
                    },
                };
                checkDueDetailsMatch(actualDD, expectedDD);
            }

            it("Should allow the EA to partially waive late fees", async function () {
                const oldDD = await creditContract.getDueDetail(creditHash);
                const waivedAmount = oldDD.lateFee.sub(toToken(1));
                const expectedNewLateFee = toToken(1);
                await testWaiveLateFee(waivedAmount, expectedNewLateFee);
            });

            it("Should allow the EA to fully waive late fees", async function () {
                const oldDD = await creditContract.getDueDetail(creditHash);
                const waivedAmount = oldDD.lateFee.add(toToken(1));
                const expectedNewLateFee = toToken(0);
                await testWaiveLateFee(waivedAmount, expectedNewLateFee);
            });

            it("Should not allow update when the protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .waiveLateFee(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .waiveLateFee(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not allow non-EAs to waive the late fee", async function () {
                await expect(
                    creditManagerContract.waiveLateFee(borrower.getAddress(), toToken(1)),
                ).to.be.revertedWithCustomError(
                    creditManagerContract,
                    "evaluationAgentServiceAccountRequired",
                );
            });
        });
    });
});
