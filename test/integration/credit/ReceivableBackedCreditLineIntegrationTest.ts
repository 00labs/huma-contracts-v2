import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Receivable,
    ReceivableBackedCreditLine,
    ReceivableBackedCreditLineManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import {
    CreditState,
    PayPeriodDuration,
    calcYield,
    checkCreditConfig,
    checkCreditRecord,
    checkCreditRecordsMatch,
    checkDueDetailsMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    genDueDetail,
    getPrincipal,
} from "../../BaseTest";
import {
    borrowerLevelCreditHash,
    evmRevert,
    evmSnapshot,
    getLatestBlock,
    mineNextBlockWithTimestamp,
    setNextBlockTimestamp,
    toToken,
} from "../../TestUtils";
import { CONSTANTS } from "../../constants";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress, borrower: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
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
    creditContract: ReceivableBackedCreditLine,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: ReceivableBackedCreditLineManager,
    receivableContract: Receivable;

describe("ReceivableBackedCreditLine Integration Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            sentinelServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            lender,
            borrower,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
            eaServiceAccount,
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
            creditManagerContract as unknown,
            receivableContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "ReceivableBackedCreditLine",
            "ReceivableBackedCreditLineManager",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, borrower],
        );

        await receivableContract
            .connect(poolOwner)
            .grantRole(receivableContract.MINTER_ROLE(), borrower.address);
        await poolConfigContract.connect(poolOwner).setReceivableAsset(receivableContract.address);

        await borrowerFirstLossCoverContract.connect(poolOwner).addCoverProvider(borrower.address);
        await mockTokenContract
            .connect(borrower)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);

        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(toToken(10_000_000), lender.address);
    }

    describe("Arf case tests", function () {
        let creditHash: string;
        let borrowAmount: BN, paymentAmount: BN;
        let creditLimit: BN;
        const yieldInBps = 1200;
        const lateFeeBps = 2400;
        const principalRate = 0;
        const latePaymentGracePeriodInDays = 5;
        let nextBlockTS: number;
        let advanceRate: BN;

        async function prepareForArfTests() {
            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            borrowAmount = toToken(1_000_000);
            paymentAmount = borrowAmount;
            creditLimit = borrowAmount
                .mul(5)
                .mul(CONSTANTS.BP_FACTOR.add(500))
                .div(CONSTANTS.BP_FACTOR);
            advanceRate = CONSTANTS.BP_FACTOR;

            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    payPeriodDuration: PayPeriodDuration.Monthly,
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                    advanceRateInBps: CONSTANTS.BP_FACTOR,
                    receivableAutoApproval: true,
                },
            });

            await poolConfigContract.connect(poolOwner).setFeeStructure({
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });
        }

        let sId: unknown;

        before(async function () {
            await loadFixture(prepare);
            await loadFixture(prepareForArfTests);
            sId = await evmSnapshot();
        });

        after(async function () {
            if (sId) {
                await evmRevert(sId);
            }
        });

        it("approve borrower credit", async function () {
            const poolSettings = await poolConfigContract.getPoolSettings();

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    creditLimit,
                    24,
                    yieldInBps,
                    borrowAmount,
                    0,
                    true,
                );

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            checkCreditConfig(
                cc,
                creditLimit,
                borrowAmount,
                poolSettings.payPeriodDuration,
                24,
                yieldInBps,
                true,
                advanceRate.toNumber(),
                true,
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
                24,
                CreditState.Approved,
            );
            expect(await creditManagerContract.getCreditBorrower(creditHash)).to.equal(
                await borrower.getAddress(),
            );
        });

        it("Month 1 - Day 1 ~ Day 5: drawdown in the first week", async function () {
            let block = await getLatestBlock();
            nextBlockTS =
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        block.timestamp,
                    )
                ).toNumber() -
                CONSTANTS.SECONDS_IN_A_DAY +
                100;

            // Day 1 - Day 5 loop. Create a receivable and drawdown every day.
            for (let i = 0; i < 5; i++) {
                // Move forward 1 day.
                nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextBlockTS);

                const maturityDate =
                    nextBlockTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                // Always get the receivable with index 0 since the receivable created in the previous
                // iteration of the loop has been transferred to the credit contract.
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                expect(receivableId).to.equal(i + 1);
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, receivableId);
                await creditContract
                    .connect(borrower)
                    .drawdownWithReceivable(borrower.address, receivableId, borrowAmount);
            }
        });

        it("Month 1 - Day 6 ~ Day 7: adjust committed amount to borrowAmount * 5", async function () {
            // Day6
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(nextBlockTS);

            await creditManagerContract
                .connect(eaServiceAccount)
                .updateLimitAndCommitment(borrower.address, creditLimit, borrowAmount.mul(5));

            // Day7
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
            await mineNextBlockWithTimestamp(nextBlockTS);
        });

        it("Month 1 - Day 8 ~ Day 14: make principal payment and drawdown together", async function () {
            // Day 8 - Day 12 loop. Make principal payment and drawdown every day.
            for (let i = 0; i < 5; i++) {
                // Move forward 1 day
                nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextBlockTS);

                const maturityDate =
                    nextBlockTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                expect(receivableId).to.equal(i + 6);
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, receivableId);

                await creditContract
                    .connect(borrower)
                    .makePrincipalPaymentAndDrawdownWithReceivable(
                        borrower.address,
                        receivableId.sub(5),
                        paymentAmount,
                        receivableId,
                        borrowAmount,
                    );
            }

            // Day13, Day14. Rest during the last two days of the week.
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextBlockTS);
        });

        it("Month 1 - Day 15 ~ Day 21: make payment and drawdown together", async function () {
            // Day 15 - Day 20 loop. Make principal payment and drawdown every day.
            for (let i = 0; i < 5; i++) {
                // Move forward 1 day.
                nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextBlockTS);

                const maturityDate =
                    nextBlockTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                expect(receivableId).to.equal(i + 11);
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, receivableId);

                await creditContract
                    .connect(borrower)
                    .makePrincipalPaymentAndDrawdownWithReceivable(
                        borrower.address,
                        receivableId.sub(5),
                        paymentAmount,
                        receivableId,
                        borrowAmount,
                    );
            }

            // Day 21, Day 22. Rest during the last two days of the week.
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextBlockTS);
        });

        it("Month 1 - Day 22 ~ Day 28: make payment and drawdown together", async function () {
            // Day 22 - Day 26 loop. Make principal payment and drawdown every day.
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextBlockTS);

                const maturityDate =
                    nextBlockTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                expect(receivableId).to.equal(i + 16);
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, receivableId);

                await creditContract
                    .connect(borrower)
                    .makePrincipalPaymentAndDrawdownWithReceivable(
                        borrower.address,
                        receivableId.sub(5),
                        paymentAmount,
                        receivableId,
                        borrowAmount,
                    );
            }

            // Day 27, Day 28. Rest during the last two days of the week.
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextBlockTS);
        });

        it("Month 2 - Day 1: pay yield for month 1", async function () {
            // Day 1
            const startOfPeriod = await calendarContract.getStartDateOfNextPeriod(
                PayPeriodDuration.Monthly,
                nextBlockTS,
            );
            nextBlockTS = startOfPeriod.toNumber() + 100;
            await setNextBlockTimestamp(nextBlockTS);

            const oldCR = await creditContract.getCreditRecord(creditHash);
            const oldDD = await creditContract.getDueDetail(creditHash);
            // The expected yield due came from the first 5 days, where the borrower drew down
            // `borrowAmount` every day. No additional yield due was generated afterward since
            // the principal payment and borrow amount were the same.
            let expectedYieldDue = BN.from(0);
            for (let i = 0; i < 5; ++i) {
                expectedYieldDue = expectedYieldDue.add(
                    calcYield(borrowAmount, yieldInBps, CONSTANTS.DAYS_IN_A_MONTH - i),
                );
            }
            expect(oldCR.nextDue).to.equal(expectedYieldDue);
            await creditContract
                .connect(borrower)
                .makePaymentWithReceivable(borrower.address, 1, oldCR.nextDue);

            // A new bill should have been generated with yield due for the month.
            const actualCR = await creditContract.getCreditRecord(creditHash);
            const startOfNextPeriod = await calendarContract.getStartDateOfNextPeriod(
                PayPeriodDuration.Monthly,
                startOfPeriod,
            );
            const yieldDue = calcYield(borrowAmount.mul(5), yieldInBps, CONSTANTS.DAYS_IN_A_MONTH);
            const expectedCR = {
                ...oldCR,
                ...{
                    nextDueDate: startOfNextPeriod,
                    nextDue: yieldDue,
                    yieldDue,
                    remainingPeriods: oldCR.remainingPeriods - 1,
                },
            };
            checkCreditRecordsMatch(actualCR, expectedCR);

            const actualDD = await creditContract.getDueDetail(creditHash);
            const expectedDD = {
                ...oldDD,
                ...{
                    committed: yieldDue,
                    accrued: yieldDue,
                    paid: 0,
                },
            };
            checkDueDetailsMatch(actualDD, expectedDD);
        });

        it("Month 2 - Day 1 ~ Day 7: make payment and drawdown together", async function () {
            let block = await getLatestBlock();
            nextBlockTS = block.timestamp - CONSTANTS.SECONDS_IN_A_DAY + 100;

            // Day 1 - Day 5 loop
            for (let i = 0; i < 5; i++) {
                // Move forward 1 day.
                nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextBlockTS);

                const maturityDate =
                    nextBlockTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                expect(receivableId).to.equal(i + 21);
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, receivableId);

                await creditContract
                    .connect(borrower)
                    .makePrincipalPaymentAndDrawdownWithReceivable(
                        borrower.address,
                        receivableId.sub(5),
                        paymentAmount,
                        receivableId,
                        borrowAmount,
                    );
            }

            // Day 6, Day 7
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextBlockTS);
        });

        it("Month 2 - Day 8 ~ Day 12: make payment and drawdown together", async function () {
            // Day 8 - Day 12 loop
            for (let i = 0; i < 5; i++) {
                // Move forward 1 day
                nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextBlockTS);

                const maturityDate =
                    nextBlockTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                expect(receivableId).to.equal(i + 26);
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, receivableId);

                await creditContract
                    .connect(borrower)
                    .makePrincipalPaymentAndDrawdownWithReceivable(
                        borrower.address,
                        receivableId.sub(5),
                        paymentAmount,
                        receivableId,
                        borrowAmount,
                    );
            }
        });

        it("Month 2 - Day 13 ~ Day 14: adjust committed amount to borrowAmount * 10", async function () {
            // Nothing happens on day 13. On day 14, we adjust the committed amount.
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await setNextBlockTimestamp(nextBlockTS);

            borrowAmount = borrowAmount.mul(2);
            creditLimit = borrowAmount
                .mul(5)
                .mul(CONSTANTS.BP_FACTOR.add(500))
                .div(CONSTANTS.BP_FACTOR);
            await creditManagerContract
                .connect(eaServiceAccount)
                .updateLimitAndCommitment(borrower.address, creditLimit, borrowAmount.mul(5));
        });

        it("Month 2 - Day 15 ~ Day 21: make payment and drawdown together", async function () {
            // Day 15 - Day 19 loop
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextBlockTS);

                const maturityDate =
                    nextBlockTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                expect(receivableId).to.equal(i + 31);
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, receivableId);

                await creditContract
                    .connect(borrower)
                    .makePrincipalPaymentAndDrawdownWithReceivable(
                        borrower.address,
                        receivableId.sub(5),
                        paymentAmount,
                        receivableId,
                        borrowAmount,
                    );
            }

            // Day 20, Day 21
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextBlockTS);

            paymentAmount = borrowAmount;
        });

        it("Month 2 - Day 22 ~ Day 28: make payment and drawdown together", async function () {
            // Day 22 - Day 26 loop
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextBlockTS);

                const maturityDate =
                    nextBlockTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                expect(receivableId).to.equal(i + 36);
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, receivableId);

                await creditContract
                    .connect(borrower)
                    .makePrincipalPaymentAndDrawdownWithReceivable(
                        borrower.address,
                        receivableId.sub(5),
                        paymentAmount,
                        receivableId,
                        borrowAmount,
                    );
            }

            // Day 27, Day 28
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextBlockTS);
        });

        it("Month 3 - Day 6: refresh credit and credit state becomes Delayed", async function () {
            // There was no interest payment at the beginning of the month, and now we are
            // on day 6.
            const startOfPeriod = await calendarContract.getStartDateOfNextPeriod(
                PayPeriodDuration.Monthly,
                nextBlockTS,
            );
            nextBlockTS = startOfPeriod.toNumber() + CONSTANTS.SECONDS_IN_A_DAY * 5 + 100;
            await setNextBlockTimestamp(nextBlockTS);
            const oldCR = await creditContract.getCreditRecord(creditHash);
            const oldDD = await creditContract.getDueDetail(creditHash);
            // Check whether the bill has the expected amount of yield due from last month prior to refresh.
            const principal = getPrincipal(oldCR, oldDD);
            // The expected yield due consists of two parts:
            // 1. For the first 14 days of the month, there was yield generated from the borrowed amount.
            // 2. For the remaining 16 days of the month, there was yield generated from the committed amount since
            //    it was higher than the borrowed amount initially.
            const expectedYieldDue = calcYield(borrowAmount.mul(5).div(2), yieldInBps, 14).add(
                calcYield(borrowAmount.mul(5), yieldInBps, 16),
            );
            expect(oldCR.yieldDue).to.equal(expectedYieldDue);

            await creditManagerContract.refreshCredit(borrower.address);

            const actualCR = await creditContract.getCreditRecord(creditHash);
            const startOfNextPeriod = await calendarContract.getStartDateOfNextPeriod(
                PayPeriodDuration.Monthly,
                startOfPeriod,
            );
            const yieldDue = calcYield(principal, yieldInBps, CONSTANTS.DAYS_IN_A_MONTH);
            const daysPassedSincePeriodStart = 6;
            const lateFee = calcYield(principal, lateFeeBps, daysPassedSincePeriodStart);
            const expectedCR = {
                ...oldCR,
                ...{
                    nextDueDate: startOfNextPeriod,
                    nextDue: yieldDue,
                    yieldDue,
                    totalPastDue: oldCR.yieldDue.add(lateFee),
                    missedPeriods: 1,
                    remainingPeriods: oldCR.remainingPeriods - 1,
                    state: CreditState.Delayed,
                },
            };
            checkCreditRecordsMatch(actualCR, expectedCR);

            const actualDD = await creditContract.getDueDetail(creditHash);
            const startOfNextDay = await calendarContract.getStartOfNextDay(nextBlockTS);
            const expectedDD = genDueDetail({
                lateFeeUpdatedDate: startOfNextDay,
                lateFee,
                yieldPastDue: oldCR.nextDue,
                committed: yieldDue,
                accrued: yieldDue,
            });
            checkDueDetailsMatch(actualDD, expectedDD);

            // Calling makePrincipalPaymentAndDrawdownWithReceivable fails
            const maturityDate =
                nextBlockTS + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
            await receivableContract
                .connect(borrower)
                .createReceivable(1, borrowAmount, maturityDate, "", "");
            const receivableId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            await receivableContract
                .connect(borrower)
                .approve(creditContract.address, receivableId);

            await expect(
                creditContract
                    .connect(borrower)
                    .makePrincipalPaymentAndDrawdownWithReceivable(
                        borrower.address,
                        receivableId.sub(5),
                        paymentAmount,
                        receivableId,
                        borrowAmount,
                    ),
            ).to.be.revertedWithCustomError(
                creditContract,
                "CreditNotInStateForMakingPrincipalPayment",
            );
        });

        it("Month 3 - Day 7: pay yield past due and late fee to bring the bill back to GoodStanding", async function () {
            // Day 7
            nextBlockTS += CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(nextBlockTS);

            const oldCR = await creditContract.getCreditRecord(creditHash);
            const oldDD = await creditContract.getDueDetail(creditHash);
            const principal = getPrincipal(oldCR, oldDD);
            // The bill was refreshed on th 6th, so we need to charge an additional day worth of late fee.
            const daysPassed = 1;
            const additionalLateFee = calcYield(principal, lateFeeBps, daysPassed);
            await creditContract
                .connect(borrower)
                .makePaymentWithReceivable(
                    borrower.address,
                    1,
                    oldCR.totalPastDue.add(additionalLateFee),
                );

            const actualCR = await creditContract.getCreditRecord(creditHash);
            const expectedCR = {
                ...oldCR,
                ...{
                    totalPastDue: 0,
                    missedPeriods: 0,
                    state: CreditState.GoodStanding,
                },
            };
            checkCreditRecordsMatch(actualCR, expectedCR);

            const actualDD = await creditContract.getDueDetail(creditHash);
            const expectedDD = {
                ...oldDD,
                ...{
                    lateFeeUpdatedDate: 0,
                    lateFee: 0,
                    yieldPastDue: 0,
                },
            };
            checkDueDetailsMatch(actualDD, expectedDD);
        });

        it("Month 3 - Day 7: make payment and drawdown together", async function () {
            const receivableId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            const oldCR = await creditContract.getCreditRecord(creditHash);
            const oldDD = await creditContract.getDueDetail(creditHash);

            await creditContract
                .connect(borrower)
                .makePrincipalPaymentAndDrawdownWithReceivable(
                    borrower.address,
                    receivableId.sub(5),
                    paymentAmount,
                    receivableId,
                    borrowAmount,
                );

            const actualCR = await creditContract.getCreditRecord(creditHash);
            checkCreditRecordsMatch(actualCR, oldCR);

            const actualDD = await creditContract.getDueDetail(creditHash);
            checkDueDetailsMatch(actualDD, oldDD);
        });
    });
});
