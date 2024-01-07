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
    CONSTANTS,
    CreditState,
    PayPeriodDuration,
    calcLateFeeNew,
    checkCreditConfig,
    checkCreditRecord,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    printCreditRecord,
} from "../../BaseTest";
import {
    borrowerLevelCreditHash,
    evmRevert,
    evmSnapshot,
    getLatestBlock,
    mineNextBlockWithTimestamp,
    setNextBlockTimestamp,
    timestampToMoment,
    toToken,
} from "../../TestUtils";

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
    affiliateFirstLossCoverContract: FirstLossCover,
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
            affiliateFirstLossCoverContract,
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
                yieldInBps,
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

        let nextTime: number;
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

        it("Month1 - Day1 ~ Day5: drawdown in the first week", async function () {
            let block = await getLatestBlock();
            nextTime =
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        block.timestamp,
                    )
                ).toNumber() -
                CONSTANTS.SECONDS_IN_A_DAY +
                100;

            // Day1 - Day5 loop
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextTime += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextTime);

                const maturityDate =
                    nextTime + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                console.log(`receivableId: ${receivableId}`);
                await receivableContract
                    .connect(borrower)
                    .approve(creditContract.address, receivableId);
                await creditContract
                    .connect(borrower)
                    .drawdownWithReceivable(borrower.address, receivableId, borrowAmount);
            }
        });

        it("Month1 - Day6 ~ Day7: adjust committed to borrowAmount * 5", async function () {
            // Day6
            nextTime += CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(nextTime);

            await creditManagerContract
                .connect(eaServiceAccount)
                .updateLimitAndCommitment(borrower.address, creditLimit, borrowAmount.mul(5));

            // Day7
            nextTime += CONSTANTS.SECONDS_IN_A_DAY;
            await mineNextBlockWithTimestamp(nextTime);
        });

        it("Month1 - Day8 ~ Day14: make payment and drawdown together", async function () {
            // Day8 - Day12 loop
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextTime += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextTime);

                const maturityDate =
                    nextTime + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                console.log(`receivableId: ${receivableId}`);
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

            // Day13, Day14
            nextTime += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextTime);
        });

        it("Month1 - Day15 ~ Day21: make payment and drawdown together", async function () {
            // Day15 - Day20 loop
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextTime += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextTime);

                const maturityDate =
                    nextTime + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                console.log(`receivableId: ${receivableId}`);
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

            // Day21, Day22
            nextTime += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextTime);
        });

        it("Month1 - Day22 ~ Day28: make payment and drawdown together", async function () {
            // Day22 - Day26 loop
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextTime += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextTime);

                const maturityDate =
                    nextTime + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                console.log(`receivableId: ${receivableId}`);
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

            // Day27, Day28
            nextTime += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextTime);
        });

        it("Month2 - Day1: pay Month1's yield", async function () {
            // Day1
            nextTime =
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        nextTime,
                    )
                ).toNumber() + 100;
            await setNextBlockTimestamp(nextTime);

            let cr = await creditContract.getCreditRecord(creditHash);
            await creditContract
                .connect(borrower)
                .makePaymentWithReceivable(borrower.address, 1, cr.nextDue);
        });

        it("Month2 - Day1 ~ Day7: make payment and drawdown together", async function () {
            let block = await getLatestBlock();
            nextTime = block.timestamp - CONSTANTS.SECONDS_IN_A_DAY + 100;

            // Day1 - Day5 loop
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextTime += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextTime);

                const maturityDate =
                    nextTime + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                console.log(`receivableId: ${receivableId}`);
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

            // Day6, Day7
            nextTime += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextTime);
        });

        it("Month2 - Day8 ~ Day12: make payment and drawdown together", async function () {
            // Day8 - Day12 loop
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextTime += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextTime);

                const maturityDate =
                    nextTime + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                console.log(`receivableId: ${receivableId}`);
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

        it("Month2 - Day13 ~ Day14: adjust committed to borrowAmount * 10", async function () {
            // Day6
            nextTime += CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(nextTime);

            borrowAmount = borrowAmount.mul(2);
            creditLimit = borrowAmount
                .mul(5)
                .mul(CONSTANTS.BP_FACTOR.add(500))
                .div(CONSTANTS.BP_FACTOR);
            await creditManagerContract
                .connect(eaServiceAccount)
                .updateLimitAndCommitment(borrower.address, creditLimit, borrowAmount.mul(5));

            // Day7
            nextTime += CONSTANTS.SECONDS_IN_A_DAY;
            await mineNextBlockWithTimestamp(nextTime);
        });

        it("Month2 - Day15 ~ Day21: make payment and drawdown together", async function () {
            // Day15 - Day20 loop
            for (let i = 0; i < 5; i++) {
                // move forward 1 day
                nextTime += CONSTANTS.SECONDS_IN_A_DAY;
                await setNextBlockTimestamp(nextTime);

                const maturityDate =
                    nextTime + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
                await receivableContract
                    .connect(borrower)
                    .createReceivable(1, borrowAmount, maturityDate, "", "");
                const receivableId = await receivableContract.tokenOfOwnerByIndex(
                    borrower.address,
                    0,
                );
                console.log(`receivableId: ${receivableId}`);
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

            // Day21, Day22
            nextTime += CONSTANTS.SECONDS_IN_A_DAY * 2;
            await mineNextBlockWithTimestamp(nextTime);

            paymentAmount = borrowAmount;
        });

        it("Month3 - Day6: refresh credit and credit state becomes Delayed", async function () {
            // Day6
            nextTime =
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        PayPeriodDuration.Monthly,
                        nextTime,
                    )
                ).toNumber() +
                CONSTANTS.SECONDS_IN_A_DAY * 6 +
                100;
            await setNextBlockTimestamp(nextTime);

            await creditManagerContract.refreshCredit(borrower.address);
            let cr = await creditContract.getCreditRecord(creditHash);
            printCreditRecord("cr", cr);

            // Calling makePrincipalPaymentAndDrawdownWithReceivable fails
            const maturityDate = nextTime + CONSTANTS.SECONDS_IN_A_DAY * CONSTANTS.DAYS_IN_A_MONTH;
            await receivableContract
                .connect(borrower)
                .createReceivable(1, borrowAmount, maturityDate, "", "");
            const receivableId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            console.log(`receivableId: ${receivableId}`);
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

        it("Month3 - Day7: pay yield including late fee", async function () {
            // Day7
            nextTime += CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(nextTime);

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            let cr = await creditContract.getCreditRecord(creditHash);
            let dd = await creditContract.getDueDetail(creditHash);
            let [, lateFee] = await calcLateFeeNew(
                poolConfigContract,
                calendarContract,
                cc,
                cr,
                dd,
                timestampToMoment(nextTime),
                5,
            );
            await creditContract
                .connect(borrower)
                .makePaymentWithReceivable(
                    borrower.address,
                    1,
                    cr.nextDue.add(cr.totalPastDue.sub(dd.lateFee)).add(lateFee),
                );
            cr = await creditContract.getCreditRecord(creditHash);
            printCreditRecord("cr", cr);
        });

        it("Month3 - Day7: make payment and drawdown together", async function () {
            const receivableId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            console.log(`receivableId: ${receivableId}`);

            await creditContract
                .connect(borrower)
                .makePrincipalPaymentAndDrawdownWithReceivable(
                    borrower.address,
                    receivableId.sub(5),
                    paymentAmount,
                    receivableId,
                    borrowAmount,
                );
        });
    });
});
