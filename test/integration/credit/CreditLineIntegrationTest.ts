import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import moment from "moment";
import {
    Calendar,
    CreditDueManager,
    CreditLine,
    CreditLineManager,
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
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import {
    CreditState,
    FeeCalculator,
    FirstLossCoverInfo,
    PayPeriodDuration,
    PnLCalculator,
    calcPoolFees,
    calcPrincipalDueForFullPeriods,
    calcPrincipalDueForPartialPeriod,
    calcYield,
    calcYieldDue,
    checkCreditConfig,
    checkCreditConfigsMatch,
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
    getFirstLossCoverInfo,
    isCloseTo,
    overrideFirstLossCoverConfig,
    overrideLPConfig,
    setNextBlockTimestamp,
    sumBNArray,
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
let juniorLender: SignerWithAddress, seniorLender: SignerWithAddress, borrower: SignerWithAddress;

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
    creditContract: CreditLine,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: CreditLineManager,
    receivableContract: Receivable;

let feeCalculator: FeeCalculator;

describe("CreditLine Integration Test", function () {
    let creditHash: string;
    let creditLimit: BN,
        committedAmount: BN,
        newCommittedAmount: BN,
        frontLoadingFeeFlat: BN,
        coverCapPerLoss: BN;
    let nextYear: number, designatedStartDate: moment.Moment;
    const yieldInBps = 1200,
        newYieldInBps = 600,
        lateFeeBps = 2400,
        principalRateInBps = 200,
        numPeriods = 12,
        riskAdjustment = 8000,
        coverRatePerLossInBps = 5_000;
    let payPeriodDuration: PayPeriodDuration;
    const latePaymentGracePeriodInDays = 5,
        defaultGracePeriodInDays = 10;
    let snapshotId: unknown;

    async function getAssetsAfterPnLDistribution(
        profit: BN,
        loss: BN = BN.from(0),
        lossRecovery: BN = BN.from(0),
    ) {
        await overrideLPConfig(poolConfigContract, poolOwner, {
            tranchesRiskAdjustmentInBps: riskAdjustment,
        });
        const assetInfo = await poolContract.tranchesAssets();
        const assets = [assetInfo[CONSTANTS.SENIOR_TRANCHE], assetInfo[CONSTANTS.JUNIOR_TRANCHE]];
        const lossInfo = await poolContract.tranchesLosses();
        const losses = [lossInfo[CONSTANTS.SENIOR_TRANCHE], lossInfo[CONSTANTS.JUNIOR_TRANCHE]];
        const profitAfterFees = await feeCalculator.calcPoolFeeDistribution(profit);
        const firstLossCoverInfos = await Promise.all(
            [borrowerFirstLossCoverContract, adminFirstLossCoverContract].map(
                async (contract) => await getFirstLossCoverInfo(contract, poolConfigContract),
            ),
        );

        return await PnLCalculator.calcRiskAdjustedProfitAndLoss(
            profitAfterFees,
            loss,
            lossRecovery,
            assets,
            losses,
            BN.from(riskAdjustment),
            firstLossCoverInfos,
        );
    }

    async function getFirstLossCoverInfos() {
        return await Promise.all(
            [borrowerFirstLossCoverContract, adminFirstLossCoverContract].map((contract) =>
                getFirstLossCoverInfo(contract, poolConfigContract),
            ),
        );
    }

    async function testPoolFees(
        profit: BN,
        oldAccruedIncomes: PoolFeeManager.AccruedIncomesStructOutput,
    ) {
        const protocolFeeInBps = await humaConfigContract.protocolFeeInBps();
        expect(protocolFeeInBps).to.be.gt(0);
        const adminRnR = await poolConfigContract.getAdminRnR();
        expect(adminRnR.rewardRateInBpsForPoolOwner).to.be.gt(0);
        expect(adminRnR.rewardRateInBpsForEA).to.be.gt(0);
        const actualAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
        const [additionalAccruedIncomes] = calcPoolFees(
            profit,
            protocolFeeInBps,
            adminRnR.rewardRateInBpsForPoolOwner,
            adminRnR.rewardRateInBpsForEA,
        );
        expect(
            actualAccruedIncomes.protocolIncome.sub(oldAccruedIncomes.protocolIncome),
        ).to.be.equal(additionalAccruedIncomes.protocolIncome);
        expect(
            actualAccruedIncomes.poolOwnerIncome.sub(oldAccruedIncomes.poolOwnerIncome),
        ).to.be.equal(additionalAccruedIncomes.poolOwnerIncome);
        expect(actualAccruedIncomes.eaIncome.sub(oldAccruedIncomes.eaIncome)).to.be.equal(
            additionalAccruedIncomes.eaIncome,
        );
    }

    async function testTranchesAssets(assets: BN[]) {
        const seniorAssets = await poolContract.trancheTotalAssets(CONSTANTS.SENIOR_TRANCHE);
        expect(seniorAssets).to.equal(assets[CONSTANTS.SENIOR_TRANCHE]);
        const juniorAssets = await poolContract.trancheTotalAssets(CONSTANTS.JUNIOR_TRANCHE);
        expect(juniorAssets).to.equal(assets[CONSTANTS.JUNIOR_TRANCHE]);
        const totalAssets = await poolContract.totalAssets();
        expect(totalAssets).to.equal(seniorAssets.add(juniorAssets));
    }

    async function testFirstLossCoverAssets(
        profits: BN[],
        oldFirstLossCoverInfos: FirstLossCoverInfo[],
        losses: BN[] = [BN.from(0), BN.from(0)],
        lossRecoveries: BN[] = [BN.from(0), BN.from(0)],
    ) {
        const actualFirstLossCoverInfos = await getFirstLossCoverInfos();
        actualFirstLossCoverInfos.forEach((info, index) => {
            expect(info.asset).to.equal(
                oldFirstLossCoverInfos[index].asset
                    .add(profits[index])
                    .sub(losses[index])
                    .add(lossRecoveries[index]),
            );
        });
    }

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
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "CreditLine",
            "CreditLineManager",
            evaluationAgent,
            treasury,
            poolOwnerTreasury,
            poolOperator,
            [juniorLender, seniorLender, borrower],
        );

        creditLimit = toToken(1_000_000);
        committedAmount = toToken(300_000);
        newCommittedAmount = toToken(500_000);
        frontLoadingFeeFlat = toToken(1_000);
        nextYear = moment.utc().year() + 1;
        designatedStartDate = moment.utc({
            year: nextYear + 1,
            month: 0,
            day: 2,
        });
        payPeriodDuration = PayPeriodDuration.Monthly;
        coverCapPerLoss = toToken(3_000_000);
        feeCalculator = new FeeCalculator(humaConfigContract, poolConfigContract);

        await borrowerFirstLossCoverContract.connect(poolOwner).addCoverProvider(borrower.address);
        await mockTokenContract
            .connect(borrower)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);

        const firstLossCoverMaxLiquidity = toToken(1_000_000);
        await overrideFirstLossCoverConfig(
            borrowerFirstLossCoverContract,
            CONSTANTS.BORROWER_LOSS_COVER_INDEX,
            poolConfigContract,
            poolOwner,
            {
                coverRatePerLossInBps,
                coverCapPerLoss,
                maxLiquidity: firstLossCoverMaxLiquidity,
            },
        );
        await borrowerFirstLossCoverContract
            .connect(borrower)
            .depositCover(firstLossCoverMaxLiquidity);

        await overrideFirstLossCoverConfig(
            adminFirstLossCoverContract,
            CONSTANTS.ADMIN_LOSS_COVER_INDEX,
            poolConfigContract,
            poolOwner,
            {
                coverRatePerLossInBps,
                coverCapPerLoss,
                maxLiquidity: firstLossCoverMaxLiquidity,
            },
        );
        await adminFirstLossCoverContract
            .connect(poolOwnerTreasury)
            .depositCover(firstLossCoverMaxLiquidity.div(2));

        await juniorTrancheVaultContract.connect(juniorLender).deposit(toToken(500_000));
        await seniorTrancheVaultContract.connect(seniorLender).deposit(toToken(1_500_000));

        creditHash = await borrowerLevelCreditHash(creditContract, borrower);

        let settings = await poolConfigContract.getPoolSettings();
        await poolConfigContract.connect(poolOwner).setPoolSettings({
            ...settings,
            ...{
                payPeriodDuration: payPeriodDuration,
                latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                defaultGracePeriodInDays: defaultGracePeriodInDays,
            },
        });
        await poolConfigContract.connect(poolOwner).setFeeStructure({
            yieldInBps,
            minPrincipalRateInBps: principalRateInBps,
            lateFeeBps,
        });
        await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
            frontLoadingFeeFlat,
            frontLoadingFeeBps: BN.from(0),
        });
        await overrideLPConfig(poolConfigContract, poolOwner, {
            tranchesRiskAdjustmentInBps: riskAdjustment,
        });
    }

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
            juniorLender,
            seniorLender,
            borrower,
        ] = await ethers.getSigners();

        await prepare();
        snapshotId = await evmSnapshot();
    });

    after(async function () {
        if (snapshotId) {
            await evmRevert(snapshotId);
        }
    });

    it("1/1: Approve the credit line", async function () {
        const dateOfApproval = moment.utc({
            year: nextYear + 1,
            month: 0,
            day: 1,
            hour: 9,
            minute: 27,
            second: 31,
        });
        await setNextBlockTimestamp(dateOfApproval.unix());
        await creditManagerContract
            .connect(eaServiceAccount)
            .approveBorrower(
                borrower.getAddress(),
                creditLimit,
                numPeriods,
                yieldInBps,
                committedAmount,
                designatedStartDate.unix(),
                true,
            );

        const poolSettings = await poolConfigContract.getPoolSettings();
        const actualCC = await creditManagerContract.getCreditConfig(creditHash);
        checkCreditConfig(
            actualCC,
            creditLimit,
            committedAmount,
            payPeriodDuration,
            numPeriods,
            yieldInBps,
            true,
            poolSettings.advanceRateInBps,
            poolSettings.receivableAutoApproval,
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            nextDueDate: designatedStartDate.unix(),
            unbilledPrincipal: 0,
            nextDue: 0,
            yieldDue: 0,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods,
            state: CreditState.Approved,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);
        expect(await creditManagerContract.getCreditBorrower(creditHash)).to.equal(
            await borrower.getAddress(),
        );
    });

    it("1/5: Start committed credit and 1st bill", async function () {
        const runDate = moment.utc({
            year: nextYear + 1,
            month: 0,
            day: 5,
            hour: 5,
            minute: 17,
            second: 5,
        });
        await setNextBlockTimestamp(runDate.unix());
        await expect(
            creditManagerContract
                .connect(sentinelServiceAccount)
                .startCommittedCredit(borrower.getAddress()),
        )
            .to.emit(creditManagerContract, "CommittedCreditStarted")
            .withArgs(creditHash);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedNextDueDate = await calendarContract.getStartDateOfNextPeriod(
            PayPeriodDuration.Monthly,
            designatedStartDate.unix(),
        );
        const daysPassed = await calendarContract.getDaysDiff(
            designatedStartDate.unix(),
            expectedNextDueDate,
        );
        expect(daysPassed).to.be.lt(CONSTANTS.DAYS_IN_A_MONTH);
        const expectedYieldDue = calcYield(committedAmount, yieldInBps, daysPassed.toNumber());
        const expectedCR = {
            unbilledPrincipal: BN.from(0),
            nextDueDate: expectedNextDueDate,
            nextDue: expectedYieldDue,
            yieldDue: expectedYieldDue,
            totalPastDue: BN.from(0),
            missedPeriods: 0,
            remainingPeriods: numPeriods - 1,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);
        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            committed: expectedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("1/10: Initial drawdown", async function () {
        const dateOfDrawdown = moment.utc({
            year: nextYear + 1,
            month: 0,
            day: 10,
            hour: 0,
            minute: 1,
            second: 21,
        });
        await setNextBlockTimestamp(dateOfDrawdown.unix());

        const borrowAmount = committedAmount.add(toToken(200_000));
        const netBorrowAmount = borrowAmount.sub(frontLoadingFeeFlat);

        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 1,
            day: 1,
        });
        const daysUntilNextDue = 21;
        const accruedYieldDue = calcYield(borrowAmount, yieldInBps, daysUntilNextDue);
        // Committed yield should be calculated since the designated credit start date, not the drawdown date,
        // hence 29.
        const committedYieldDue = calcYield(BN.from(committedAmount), yieldInBps, 29);
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        const principalDue = calcPrincipalDueForPartialPeriod(
            borrowAmount,
            principalRateInBps,
            daysUntilNextDue,
            CONSTANTS.DAYS_IN_A_MONTH,
        );
        const [assets, , profitsForFirstLossCovers] =
            await getAssetsAfterPnLDistribution(frontLoadingFeeFlat);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).drawdown(borrower.getAddress(), borrowAmount),
        )
            .to.emit(creditContract, "DrawdownMade")
            .withArgs(await borrower.getAddress(), borrowAmount, netBorrowAmount)
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), accruedYieldDue.add(principalDue))
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                frontLoadingFeeFlat,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(newBorrowerBalance.sub(oldBorrowerBalance)).to.equal(netBorrowAmount);
        expect(oldPoolSafeBalance.sub(newPoolSafeBalance)).to.equal(
            netBorrowAmount.add(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: borrowAmount.sub(principalDue),
            nextDueDate: nextDueDate.unix(),
            nextDue: accruedYieldDue.add(principalDue),
            yieldDue: accruedYieldDue,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 1,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            accrued: accruedYieldDue,
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(frontLoadingFeeFlat, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("1/15: 2nd drawdown within the same period", async function () {
        const dateOfDrawdown = moment.utc({
            year: nextYear + 1,
            month: 0,
            day: 15,
            hour: 0,
            minute: 1,
            second: 21,
        });
        await setNextBlockTimestamp(dateOfDrawdown.unix());

        const borrowAmount = toToken(250_000);
        const netBorrowAmount = borrowAmount.sub(frontLoadingFeeFlat);

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const daysUntilNextDue = 16;
        const additionalAccruedYieldDue = calcYield(borrowAmount, yieldInBps, daysUntilNextDue);
        expect(additionalAccruedYieldDue).to.be.gt(0);
        const additionalPrincipalDue = calcPrincipalDueForPartialPeriod(
            borrowAmount,
            principalRateInBps,
            daysUntilNextDue,
            CONSTANTS.DAYS_IN_A_MONTH,
        );
        expect(additionalPrincipalDue).to.be.gt(0);
        const nextDue = oldCR.nextDue.add(additionalAccruedYieldDue).add(additionalPrincipalDue);
        const [assets, , profitsForFirstLossCovers] =
            await getAssetsAfterPnLDistribution(frontLoadingFeeFlat);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).drawdown(borrower.getAddress(), borrowAmount),
        )
            .to.emit(creditContract, "DrawdownMade")
            .withArgs(await borrower.getAddress(), borrowAmount, netBorrowAmount)
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, oldCR.nextDueDate, nextDue)
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                frontLoadingFeeFlat,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(newBorrowerBalance.sub(oldBorrowerBalance)).to.equal(netBorrowAmount);
        expect(oldPoolSafeBalance.sub(newPoolSafeBalance)).to.equal(
            netBorrowAmount.add(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal
                .add(borrowAmount)
                .sub(additionalPrincipalDue),
            nextDueDate: oldCR.nextDueDate,
            nextDue: nextDue,
            yieldDue: oldCR.yieldDue.add(additionalAccruedYieldDue),
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 1,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                accrued: oldDD.accrued.add(additionalAccruedYieldDue),
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(frontLoadingFeeFlat, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("1/20: 1st full payment for all due", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 0,
            day: 20,
            hour: 23,
            minute: 0,
            second: 40,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const paymentAmount = oldCR.nextDue;
        const [assets, , profitsForFirstLossCovers] = await getAssetsAfterPnLDistribution(
            oldCR.yieldDue,
        );
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                oldCR.yieldDue,
                oldCR.nextDue.sub(oldCR.yieldDue),
                0,
                0,
                0,
                0,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                oldCR.yieldDue,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal,
            nextDueDate: oldCR.nextDueDate,
            nextDue: 0,
            yieldDue: 0,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 1,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                paid: oldCR.yieldDue,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(oldCR.yieldDue, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("2/1: 2nd bill", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 1,
            month: 1,
            day: 1,
            hour: 23,
            minute: 23,
            second: 43,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 2,
            day: 1,
        });
        const daysUntilNextDue = CONSTANTS.DAYS_IN_A_MONTH;
        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            oldCR.unbilledPrincipal,
            daysUntilNextDue,
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        const principalDue = calcPrincipalDueForFullPeriods(
            oldCR.unbilledPrincipal,
            principalRateInBps,
            1,
        );
        expect(principalDue).to.be.gt(0);
        const nextDue = accruedYieldDue.add(principalDue);

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), nextDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal.sub(principalDue),
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: accruedYieldDue,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 2,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            accrued: accruedYieldDue,
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("3/2: 2nd full payment for all due within the late payment grace period and the generation of the 3rd bill", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 2,
            day: 2,
            hour: 22,
            minute: 45,
            second: 23,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const paymentAmount = oldCR.nextDue;
        const [assets, , profitsForFirstLossCovers] = await getAssetsAfterPnLDistribution(
            oldCR.yieldDue,
        );
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                oldCR.yieldDue,
                oldCR.nextDue.sub(oldCR.yieldDue),
                0,
                0,
                0,
                0,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                oldCR.yieldDue,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalProfitsForFirstLossCovers),
        );

        // A new bill is generated since all next due is paid off in the late payment grace period.
        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 3,
            day: 1,
        });
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            oldCR.unbilledPrincipal,
            CONSTANTS.DAYS_IN_A_MONTH,
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        const principalDue = calcPrincipalDueForFullPeriods(
            oldCR.unbilledPrincipal,
            principalRateInBps,
            1,
        );
        expect(principalDue).to.be.gt(0);
        const nextDue = accruedYieldDue.add(principalDue);
        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal.sub(principalDue),
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: accruedYieldDue,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 3,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                accrued: accruedYieldDue,
                committed: committedYieldDue,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(oldCR.yieldDue, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("3/5: 3rd partial payment for part of yield due", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 2,
            day: 5,
            hour: 22,
            minute: 29,
            second: 52,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const paymentAmount = toToken(100);
        expect(paymentAmount).to.be.lt(oldCR.yieldDue);
        const [assets, , profitsForFirstLossCovers] =
            await getAssetsAfterPnLDistribution(paymentAmount);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                paymentAmount,
                0,
                0,
                0,
                0,
                0,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                paymentAmount,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal,
            nextDueDate: oldCR.nextDueDate,
            nextDue: oldCR.nextDue.sub(paymentAmount),
            yieldDue: oldCR.yieldDue.sub(paymentAmount),
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 3,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                paid: paymentAmount,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(paymentAmount, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("4/8: 4th full payment covering all past due and the generation of the 4th bill", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 3,
            day: 8,
            hour: 18,
            minute: 1,
            second: 43,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        // All next due in the bill prior to payment now becomes past due.
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        const lateFee = calcYield(totalPrincipal, lateFeeBps, 8);
        expect(lateFee).to.be.gt(0);
        const paymentAmount = oldCR.nextDue.add(lateFee);
        const poolProfit = oldCR.yieldDue.add(lateFee);
        const [assets, , profitsForFirstLossCovers] =
            await getAssetsAfterPnLDistribution(poolProfit);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                0,
                0,
                0,
                oldCR.yieldDue,
                lateFee,
                oldCR.nextDue.sub(oldCR.yieldDue),
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                poolProfit,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalProfitsForFirstLossCovers),
        );

        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 4,
            day: 1,
        });
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            totalPrincipal,
            CONSTANTS.DAYS_IN_A_MONTH,
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        const principalDue = calcPrincipalDueForFullPeriods(
            oldCR.unbilledPrincipal,
            principalRateInBps,
            1,
        );
        expect(principalDue).to.be.gt(0);
        const nextDue = accruedYieldDue.add(principalDue);
        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal.sub(principalDue),
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: accruedYieldDue,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 4,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            lateFeeUpdatedDate: 0,
            accrued: accruedYieldDue,
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(poolProfit, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("4/15: 5th payment covering all of next due and part of unbilled principal", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 3,
            day: 15,
            hour: 23,
            minute: 24,
            second: 59,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const amountPrincipalPaid = toToken(1_000);
        const paymentAmount = oldCR.nextDue.add(amountPrincipalPaid);
        const [assets, , profitsForFirstLossCovers] = await getAssetsAfterPnLDistribution(
            oldCR.yieldDue,
        );
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                oldCR.yieldDue,
                oldCR.nextDue.sub(oldCR.yieldDue),
                amountPrincipalPaid,
                0,
                0,
                0,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                oldCR.yieldDue,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal.sub(amountPrincipalPaid),
            nextDueDate: oldCR.nextDueDate,
            nextDue: 0,
            yieldDue: 0,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 4,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                paid: oldCR.yieldDue,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(oldCR.yieldDue, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("4/20: 6th payment: extra principal payment using `makePayment`", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 3,
            day: 20,
            hour: 15,
            minute: 5,
            second: 47,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const paymentAmount = toToken(2_000);
        const [assets] = await getAssetsAfterPnLDistribution(BN.from(0));
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                0,
                0,
                paymentAmount,
                0,
                0,
                0,
                await borrower.getAddress(),
            )
            .not.to.emit(poolContract, "ProfitDistributed");
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(paymentAmount);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal.sub(paymentAmount),
            nextDueDate: oldCR.nextDueDate,
            nextDue: 0,
            yieldDue: 0,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 4,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = oldDD;
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(BN.from(0), oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets([BN.from(0), BN.from(0)], oldFirstLossCoverInfos);
    });

    it("6/1: 6th bill. 5th bill wasn't generated, and is now late", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 1,
            month: 5,
            day: 1,
            hour: 2,
            minute: 32,
            second: 56,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 1,
        });
        const daysOverdue = CONSTANTS.DAYS_IN_A_MONTH;
        const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
            cc,
            oldCR.unbilledPrincipal,
            daysOverdue,
        );
        expect(accruedYieldPastDue).to.be.gt(committedYieldPastDue);
        const principalPastDue = calcPrincipalDueForFullPeriods(
            oldCR.unbilledPrincipal,
            principalRateInBps,
            1,
        );
        expect(principalPastDue).to.be.gt(0);
        const lateFee = calcYield(oldCR.unbilledPrincipal, lateFeeBps, 1);
        expect(lateFee).to.be.gt(0);
        const totalPastDue = accruedYieldPastDue.add(lateFee).add(principalPastDue);

        const daysUntilNextDue = CONSTANTS.DAYS_IN_A_MONTH;
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            oldCR.unbilledPrincipal,
            daysUntilNextDue,
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        const principalDue = calcPrincipalDueForFullPeriods(
            oldCR.unbilledPrincipal.sub(principalPastDue),
            principalRateInBps,
            1,
        );
        expect(principalDue).to.be.gt(0);
        const nextDue = accruedYieldDue.add(principalDue);

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), nextDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal.sub(principalPastDue).sub(principalDue),
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: accruedYieldDue,
            totalPastDue: totalPastDue,
            missedPeriods: 1,
            remainingPeriods: numPeriods - 6,
            state: CreditState.Delayed,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const lateFeeUpdatedDate = moment.utc({
            year: nextYear + 1,
            month: 5,
            day: 2,
        });
        const expectedDD = genDueDetail({
            lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
            lateFee: lateFee,
            yieldPastDue: accruedYieldPastDue,
            principalPastDue: principalPastDue,
            accrued: accruedYieldDue,
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("7/1: 7th bill. 6th bill is also late", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 1,
            hour: 23,
            minute: 52,
            second: 40,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 7,
            day: 1,
        });
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        const additionalLateFee = calcYield(totalPrincipal, lateFeeBps, CONSTANTS.DAYS_IN_A_MONTH);
        expect(additionalLateFee).to.be.gt(0);
        const totalPastDue = oldCR.totalPastDue.add(oldCR.nextDue).add(additionalLateFee);

        const daysUntilNextDue = CONSTANTS.DAYS_IN_A_MONTH;
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            totalPrincipal,
            daysUntilNextDue,
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        const principalDue = calcPrincipalDueForFullPeriods(
            oldCR.unbilledPrincipal,
            principalRateInBps,
            1,
        );
        expect(principalDue).to.be.gt(0);
        const nextDue = accruedYieldDue.add(principalDue);

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), nextDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal.sub(principalDue),
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: accruedYieldDue,
            totalPastDue: totalPastDue,
            missedPeriods: 2,
            remainingPeriods: numPeriods - 7,
            state: CreditState.Delayed,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const lateFeeUpdatedDate = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 2,
        });
        const expectedDD = genDueDetail({
            lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
            lateFee: oldDD.lateFee.add(additionalLateFee),
            yieldPastDue: oldDD.yieldPastDue.add(oldCR.yieldDue),
            principalPastDue: oldDD.principalPastDue.add(oldCR.nextDue).sub(oldCR.yieldDue),
            accrued: accruedYieldDue,
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("7/3: Additional late fee assessed within the same billing cycle", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 3,
            hour: 20,
            minute: 3,
            second: 55,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        const additionalLateFee = calcYield(totalPrincipal, lateFeeBps, 2);
        expect(additionalLateFee).to.be.gt(0);
        const totalPastDue = oldCR.totalPastDue.add(additionalLateFee);

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, oldCR.nextDueDate, oldCR.nextDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                totalPastDue: totalPastDue,
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const lateFeeUpdatedDate = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 4,
        });
        const expectedDD = genDueDetail({
            ...oldDD,
            ...{
                lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
                lateFee: oldDD.lateFee.add(additionalLateFee),
            },
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("7/5: Default triggered. Bill no longer refreshed afterwards", async function () {
        const dateOfDefault = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 5,
            hour: 20,
            minute: 29,
            second: 51,
        });
        await setNextBlockTimestamp(dateOfDefault.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        const additionalLateFee = calcYield(totalPrincipal, lateFeeBps, 2);
        expect(additionalLateFee).to.be.gt(0);
        const totalLateFee = oldDD.lateFee.add(additionalLateFee);
        const totalProfit = oldCR.yieldDue.add(oldDD.yieldPastDue).add(totalLateFee);
        const totalLoss = totalProfit.add(totalPrincipal);
        const [assets, losses, profitsForFirstLossCovers, , lossesCoveredByFirstLossCovers] =
            await getAssetsAfterPnLDistribution(totalProfit, totalLoss);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const totalLossesCoveredByFirstLossCovers = sumBNArray(lossesCoveredByFirstLossCovers);
        expect(totalLossesCoveredByFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditManagerContract.connect(eaServiceAccount).triggerDefault(borrower.getAddress()),
        )
            .to.emit(creditManagerContract, "DefaultTriggered")
            .withArgs(
                creditHash,
                totalPrincipal,
                oldCR.yieldDue.add(oldDD.yieldPastDue),
                totalLateFee,
                await eaServiceAccount.getAddress(),
            )
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, oldCR.nextDueDate, oldCR.nextDue)
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                totalProfit,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE].add(losses[CONSTANTS.JUNIOR_TRANCHE]),
            )
            .to.emit(poolContract, "LossDistributed")
            .withArgs(
                totalLoss.sub(totalLossesCoveredByFirstLossCovers),
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
                losses[CONSTANTS.SENIOR_TRANCHE],
                losses[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            totalLossesCoveredByFirstLossCovers.sub(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                totalPastDue: oldCR.totalPastDue.add(additionalLateFee),
                state: CreditState.Defaulted,
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const lateFeeUpdatedDate = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 6,
        });
        const expectedDD = {
            ...oldDD,
            ...{
                lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
                lateFee: totalLateFee,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(totalProfit, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(
            profitsForFirstLossCovers,
            oldFirstLossCoverInfos,
            lossesCoveredByFirstLossCovers,
        );

        // Any further refresh should be no-op.
        const dateOfRefresh = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 5,
            hour: 21,
            minute: 17,
            second: 4,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        await expect(creditManagerContract.refreshCredit(borrower.address)).not.to.emit(
            creditContract,
            "BillRefreshed",
        );
        const crAfterRefresh = await creditContract.getCreditRecord(creditHash);
        checkCreditRecordsMatch(crAfterRefresh, actualCR);
        const ddAfterRefresh = await creditContract.getDueDetail(creditHash);
        checkDueDetailsMatch(ddAfterRefresh, actualDD);
    });

    it("7/10: Late fee waived", async function () {
        const dateOfWaiving = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 10,
            hour: 7,
            minute: 26,
            second: 20,
        });
        await setNextBlockTimestamp(dateOfWaiving.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        expect(oldCR.totalPastDue).to.be.gt(0);
        const oldDD = await creditContract.getDueDetail(creditHash);
        expect(oldDD.lateFee).to.be.gt(0);
        const waivedAmount = oldDD.lateFee.add(toToken(1_000));

        await expect(
            creditManagerContract
                .connect(eaServiceAccount)
                .waiveLateFee(borrower.getAddress(), waivedAmount),
        )
            .to.emit(creditManagerContract, "LateFeeWaived")
            .withArgs(creditHash, oldDD.lateFee, 0, await eaServiceAccount.getAddress());

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                totalPastDue: oldCR.totalPastDue.sub(oldDD.lateFee),
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);
        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                lateFee: 0,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("7/20: Pay off. Bill back to good standing", async function () {
        // Turn off the pool first so that we can adjust the pool cap, then turn the pool back on
        // to allow payment.
        const dateOfPoolCapAdjustment = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 20,
            hour: 10,
        });
        await setNextBlockTimestamp(dateOfPoolCapAdjustment.unix());
        await poolContract.connect(poolOwner).disablePool();

        // Lower the pool and first loss cover liquidity cap.
        const existingLpConfig = await poolConfigContract.getLPConfig();
        await poolConfigContract.connect(poolOwner).setLPConfig({
            ...existingLpConfig,
            ...{
                liquidityCap: 0,
            },
        });
        const firstLossCoverConfigs = [];
        const firstLossCovers = [borrowerFirstLossCoverContract, adminFirstLossCoverContract];
        for (let i = 0; i < firstLossCovers.length; ++i) {
            const config = await poolConfigContract.getFirstLossCoverConfig(
                firstLossCovers[i].address,
            );
            firstLossCoverConfigs.push(config);
            await poolConfigContract
                .connect(poolOwner)
                .setFirstLossCover(i, firstLossCovers[i].address, {
                    ...config,
                    ...{
                        maxLiquidity: 0,
                    },
                });
        }

        await poolContract.connect(poolOwner).enablePool();

        // Any further deposit attempts by lenders should fail.
        const poolSettings = await poolConfigContract.getPoolSettings();
        await expect(
            juniorTrancheVaultContract
                .connect(juniorLender)
                .deposit(poolSettings.minDepositAmount),
        ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "TrancheLiquidityCapExceeded");
        // So do first loss covers.
        await expect(
            borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(poolSettings.minDepositAmount),
        ).to.be.revertedWithCustomError(
            borrowerFirstLossCoverContract,
            "FirstLossCoverLiquidityCapExceeded",
        );
        await expect(
            adminFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .depositCover(poolSettings.minDepositAmount),
        ).to.be.revertedWithCustomError(
            borrowerFirstLossCoverContract,
            "FirstLossCoverLiquidityCapExceeded",
        );
        await expect(
            adminFirstLossCoverContract
                .connect(evaluationAgent)
                .depositCover(poolSettings.minDepositAmount),
        ).to.be.revertedWithCustomError(
            borrowerFirstLossCoverContract,
            "FirstLossCoverLiquidityCapExceeded",
        );

        // Allow payment to go through.
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 20,
            hour: 11,
            minute: 38,
            second: 31,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const paymentAmount = oldCR.unbilledPrincipal.add(oldCR.nextDue).add(oldCR.totalPastDue);
        const [assets, losses, , lossesRecoveredByFirstLossCovers] =
            await getAssetsAfterPnLDistribution(BN.from(0), BN.from(0), paymentAmount);
        const totalLossRecoveredByFirstLossCovers = sumBNArray(lossesRecoveredByFirstLossCovers);
        expect(totalLossRecoveredByFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                oldCR.yieldDue,
                oldCR.nextDue.sub(oldCR.yieldDue),
                oldCR.unbilledPrincipal,
                oldDD.yieldPastDue,
                0,
                oldDD.principalPastDue,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "LossRecoveryDistributed")
            .withArgs(
                paymentAmount.sub(totalLossRecoveredByFirstLossCovers),
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
                losses[CONSTANTS.SENIOR_TRANCHE],
                losses[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalLossRecoveredByFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: 0,
            nextDueDate: oldCR.nextDueDate,
            nextDue: 0,
            yieldDue: 0,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 7,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            accrued: oldDD.accrued,
            committed: oldDD.committed,
            paid: oldDD.accrued,
        });
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(BN.from(0), oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(
            [BN.from(0), BN.from(0)],
            oldFirstLossCoverInfos,
            [BN.from(0), BN.from(0)],
            lossesRecoveredByFirstLossCovers,
        );

        const dateOfPoolCapRestoration = moment.utc({
            year: nextYear + 1,
            month: 6,
            day: 20,
            hour: 12,
        });
        await setNextBlockTimestamp(dateOfPoolCapRestoration.unix());
        // Restore the original liquidity caps.
        await poolContract.connect(poolOwner).disablePool();
        await poolConfigContract.connect(poolOwner).setLPConfig(existingLpConfig);
        for (let i = 0; i < firstLossCovers.length; ++i) {
            await poolConfigContract
                .connect(poolOwner)
                .setFirstLossCover(i, firstLossCovers[i].address, firstLossCoverConfigs[i]);
        }
        await poolContract.connect(poolOwner).enablePool();
    });

    it("8/1: 8th bill generated because of outstanding commitment", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 1,
            month: 7,
            day: 1,
            hour: 14,
            minute: 39,
            second: 36,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 8,
            day: 1,
        });
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        expect(totalPrincipal).to.equal(0);

        const daysUntilNextDue = CONSTANTS.DAYS_IN_A_MONTH;
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            totalPrincipal,
            daysUntilNextDue,
        );
        expect(accruedYieldDue).to.equal(0);
        expect(committedYieldDue).to.be.gt(0);
        const nextDue = committedYieldDue;

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), nextDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: 0,
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: committedYieldDue,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 8,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("9/6: 9th bill generated because of outstanding commitment, now with committed yield past due", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 1,
            month: 8,
            day: 6,
            hour: 7,
            minute: 26,
            second: 40,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 9,
            day: 1,
        });
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        expect(totalPrincipal).to.equal(0);
        const daysUntilNextDue = CONSTANTS.DAYS_IN_A_MONTH;
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            totalPrincipal,
            daysUntilNextDue,
        );
        expect(accruedYieldDue).to.equal(0);
        expect(committedYieldDue).to.be.gt(0);
        const nextDue = committedYieldDue;
        const lateFee = calcYield(committedAmount, lateFeeBps, 6);
        expect(lateFee).to.be.gt(0);
        const totalPastDue = oldCR.yieldDue.add(lateFee);

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), nextDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: 0,
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: committedYieldDue,
            totalPastDue: totalPastDue,
            missedPeriods: 1,
            remainingPeriods: numPeriods - 9,
            state: CreditState.Delayed,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const lateFeeUpdatedDate = moment.utc({
            year: nextYear + 1,
            month: 8,
            day: 7,
        });
        const expectedDD = genDueDetail({
            lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
            lateFee: lateFee,
            yieldPastDue: oldCR.yieldDue,
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("10/1: 10th bill generated because of outstanding commitment, also with committed yield past due", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 1,
            month: 9,
            day: 1,
            hour: 10,
            minute: 36,
            second: 38,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 10,
            day: 1,
        });
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        expect(totalPrincipal).to.equal(0);
        const daysUntilNextDue = CONSTANTS.DAYS_IN_A_MONTH;
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            totalPrincipal,
            daysUntilNextDue,
        );
        expect(accruedYieldDue).to.equal(0);
        expect(committedYieldDue).to.be.gt(0);
        const nextDue = committedYieldDue;
        const additionalLateFee = calcYield(committedAmount, lateFeeBps, 25);
        expect(additionalLateFee).to.be.gt(0);
        const totalPastDue = oldCR.totalPastDue.add(oldCR.yieldDue).add(additionalLateFee);

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), nextDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: 0,
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: committedYieldDue,
            totalPastDue: totalPastDue,
            missedPeriods: 2,
            remainingPeriods: numPeriods - 10,
            state: CreditState.Delayed,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const lateFeeUpdatedDate = moment.utc({
            year: nextYear + 1,
            month: 9,
            day: 2,
        });
        const expectedDD = genDueDetail({
            lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
            lateFee: oldDD.lateFee.add(additionalLateFee),
            yieldPastDue: oldDD.yieldPastDue.add(oldCR.yieldDue),
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("10/5: New drawdown attempt blocked due to the bill being late. Then all due paid off", async function () {
        const dateOfDrawdown = moment.utc({
            year: nextYear + 1,
            month: 9,
            day: 5,
            hour: 0,
            minute: 1,
            second: 59,
        });
        await setNextBlockTimestamp(dateOfDrawdown.unix());
        await expect(
            creditContract.connect(borrower).drawdown(borrower.getAddress(), toToken(10_000)),
        ).to.be.revertedWithCustomError(creditContract, "CreditNotInStateForDrawdown");

        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 9,
            day: 5,
            hour: 17,
            minute: 17,
            second: 52,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const additionalLateFee = calcYield(committedAmount, lateFeeBps, 4);
        expect(additionalLateFee).to.be.gt(0);
        const paymentAmount = oldCR.nextDue.add(oldCR.totalPastDue).add(additionalLateFee);
        const totalProfit = oldCR.yieldDue
            .add(oldDD.yieldPastDue)
            .add(oldDD.lateFee)
            .add(additionalLateFee);
        const [assets, , profitsForFirstLossCovers] =
            await getAssetsAfterPnLDistribution(totalProfit);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                oldCR.yieldDue,
                0,
                0,
                oldDD.yieldPastDue,
                oldDD.lateFee.add(additionalLateFee),
                0,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                totalProfit,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: 0,
            nextDueDate: oldCR.nextDueDate,
            nextDue: 0,
            yieldDue: 0,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 10,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            committed: oldDD.committed,
            paid: oldDD.committed,
        });
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(totalProfit, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("10/15: New drawdown", async function () {
        const dateOfDrawdown = moment.utc({
            year: nextYear + 1,
            month: 9,
            day: 15,
            hour: 6,
            minute: 27,
            second: 23,
        });
        await setNextBlockTimestamp(dateOfDrawdown.unix());

        const borrowAmount = committedAmount.add(toToken(300_000));
        const netBorrowAmount = borrowAmount.sub(frontLoadingFeeFlat);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        expect(oldDD.committed).to.equal(oldDD.paid);
        const daysUntilNextDue = 16;
        const accruedYieldDue = calcYield(borrowAmount, yieldInBps, daysUntilNextDue);
        const principalDue = calcPrincipalDueForPartialPeriod(
            borrowAmount,
            principalRateInBps,
            daysUntilNextDue,
            CONSTANTS.DAYS_IN_A_MONTH,
        );
        expect(accruedYieldDue).to.be.gt(oldDD.committed);
        const [assets, , profitsForFirstLossCovers] =
            await getAssetsAfterPnLDistribution(frontLoadingFeeFlat);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).drawdown(borrower.getAddress(), borrowAmount),
        )
            .to.emit(creditContract, "DrawdownMade")
            .withArgs(await borrower.getAddress(), borrowAmount, netBorrowAmount)
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(
                creditHash,
                oldCR.nextDueDate,
                accruedYieldDue.add(principalDue).sub(oldDD.paid),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                frontLoadingFeeFlat,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(newBorrowerBalance.sub(oldBorrowerBalance)).to.equal(netBorrowAmount);
        expect(oldPoolSafeBalance.sub(newPoolSafeBalance)).to.equal(
            netBorrowAmount.add(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                unbilledPrincipal: borrowAmount.sub(principalDue),
                nextDue: accruedYieldDue.add(principalDue).sub(oldDD.paid),
                yieldDue: accruedYieldDue.sub(oldDD.paid),
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                accrued: accruedYieldDue,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(frontLoadingFeeFlat, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("10/20: Committed amount adjusted to be above the drawdown amount", async function () {
        const dateOfAdjustment = moment.utc({
            year: nextYear + 1,
            month: 9,
            day: 20,
            hour: 8,
            minute: 49,
            second: 36,
        });
        await setNextBlockTimestamp(dateOfAdjustment.unix());

        const oldCC = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const newCommittedYield = calcYield(oldCC.committedAmount, yieldInBps, 20).add(
            calcYield(newCommittedAmount, yieldInBps, 10),
        );
        expect(newCommittedYield).to.be.gt(oldDD.accrued);

        await expect(
            creditManagerContract
                .connect(eaServiceAccount)
                .updateLimitAndCommitment(borrower.getAddress(), creditLimit, newCommittedAmount),
        )
            .to.emit(creditManagerContract, "LimitAndCommitmentUpdated")
            .withArgs(
                creditHash,
                creditLimit,
                creditLimit,
                committedAmount,
                newCommittedAmount,
                oldCR.yieldDue,
                newCommittedYield.sub(oldDD.paid),
                await eaServiceAccount.getAddress(),
            );

        const actualCC = await creditManagerContract.getCreditConfig(creditHash);
        const expectedCC = {
            ...oldCC,
            ...{
                committedAmount: newCommittedAmount,
            },
        };
        checkCreditConfigsMatch(actualCC, expectedCC);
        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                nextDue: oldCR.nextDue.sub(oldDD.accrued).add(newCommittedYield),
                yieldDue: newCommittedYield.sub(oldDD.paid),
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);
        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                committed: newCommittedYield,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("11/2: Full payment within late payment grace period and 11th bill", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 10,
            day: 2,
            hour: 6,
            minute: 50,
            second: 24,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const paymentAmount = oldCR.nextDue;

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                oldCR.yieldDue,
                oldCR.nextDue.sub(oldCR.yieldDue),
                0,
                0,
                0,
                0,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed");
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        // expect(newPoolSafeBalance.add(oldPoolSafeBalance)).to.equal(paymentAmount);

        // A new bill is generated since all next due is paid off in the late payment grace period.
        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const nextDueDate = moment.utc({
            year: nextYear + 1,
            month: 11,
            day: 1,
        });
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            oldCR.unbilledPrincipal,
            CONSTANTS.DAYS_IN_A_MONTH,
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        const principalDue = calcPrincipalDueForFullPeriods(
            oldCR.unbilledPrincipal,
            principalRateInBps,
            1,
        );
        expect(principalDue).to.be.gt(0);
        const nextDue = accruedYieldDue.add(principalDue);
        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: oldCR.unbilledPrincipal.sub(principalDue),
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: accruedYieldDue,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: numPeriods - 11,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            accrued: accruedYieldDue,
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("11/4: Yield adjusted downwards", async function () {
        const dateOfUpdate = moment.utc({
            year: nextYear + 1,
            month: 10,
            day: 4,
            hour: 0,
            minute: 57,
            second: 56,
        });
        await setNextBlockTimestamp(dateOfUpdate.unix());

        const oldCC = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        const daysPassed = 4;
        const accruedYieldDue = calcYield(totalPrincipal, yieldInBps, daysPassed).add(
            calcYield(totalPrincipal, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - daysPassed),
        );
        const committedYieldDue = calcYield(newCommittedAmount, yieldInBps, daysPassed).add(
            calcYield(newCommittedAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - daysPassed),
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);

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
                oldCR.yieldDue,
                (actualAccruedYieldDue: BN) =>
                    isCloseTo(actualAccruedYieldDue, accruedYieldDue, BN.from(1)),
                await eaServiceAccount.getAddress(),
            );

        const actualCC = await creditManagerContract.getCreditConfig(creditHash);
        const expectedCC = {
            ...oldCC,
            ...{
                yieldInBps: newYieldInBps,
            },
        };
        checkCreditConfigsMatch(actualCC, expectedCC);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                nextDue: accruedYieldDue.add(oldCR.nextDue).sub(oldCR.yieldDue),
                yieldDue: accruedYieldDue,
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR, BN.from(1));

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                accrued: accruedYieldDue,
                committed: committedYieldDue,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD, BN.from(1));
    });

    it("11/12: Additional drawdown", async function () {
        const dateOfDrawdown = moment.utc({
            year: nextYear + 1,
            month: 10,
            day: 12,
            hour: 1,
            minute: 47,
            second: 46,
        });
        await setNextBlockTimestamp(dateOfDrawdown.unix());

        const borrowAmount = toToken(100_000);
        const netBorrowAmount = borrowAmount.sub(frontLoadingFeeFlat);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const daysUntilNextDue = 19;
        const additionalAccruedYieldDue = calcYield(borrowAmount, newYieldInBps, daysUntilNextDue);
        const additionalPrincipalDue = calcPrincipalDueForPartialPeriod(
            borrowAmount,
            principalRateInBps,
            daysUntilNextDue,
            CONSTANTS.DAYS_IN_A_MONTH,
        );
        const nextDue = oldCR.nextDue.add(additionalAccruedYieldDue).add(additionalPrincipalDue);
        const [assets, , profitsForFirstLossCovers] =
            await getAssetsAfterPnLDistribution(frontLoadingFeeFlat);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).drawdown(borrower.getAddress(), borrowAmount),
        )
            .to.emit(creditContract, "DrawdownMade")
            .withArgs(await borrower.getAddress(), borrowAmount, netBorrowAmount)
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, oldCR.nextDueDate, nextDue)
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                frontLoadingFeeFlat,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(newBorrowerBalance.sub(oldBorrowerBalance)).to.equal(netBorrowAmount);
        expect(oldPoolSafeBalance.sub(newPoolSafeBalance)).to.equal(
            netBorrowAmount.add(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                unbilledPrincipal: oldCR.unbilledPrincipal
                    .add(borrowAmount)
                    .sub(additionalPrincipalDue),
                nextDue: nextDue,
                yieldDue: oldCR.yieldDue.add(additionalAccruedYieldDue),
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                accrued: oldDD.accrued.add(additionalAccruedYieldDue),
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(frontLoadingFeeFlat, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("11/15: Partial principal payment with `makePrincipalPayment`", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 10,
            day: 15,
            hour: 21,
            minute: 6,
            second: 30,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const paymentAmount = toToken(150_000);
        const principalDuePaid = oldCR.nextDue.sub(oldCR.yieldDue);
        const unbilledPrincipalPaid = paymentAmount.sub(principalDuePaid);

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract
                .connect(borrower)
                .makePrincipalPayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PrincipalPaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                oldCR.nextDueDate,
                0,
                oldCR.unbilledPrincipal.sub(unbilledPrincipalPaid),
                principalDuePaid,
                unbilledPrincipalPaid,
                await borrower.getAddress(),
            )
            .not.to.emit(poolContract, "ProfitDistributed");
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(paymentAmount);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                unbilledPrincipal: oldCR.unbilledPrincipal.sub(unbilledPrincipalPaid),
                nextDue: oldCR.yieldDue,
                yieldDue: oldCR.yieldDue,
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = oldDD;
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("11/20: Full payment for all due", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 1,
            month: 10,
            day: 20,
            hour: 16,
            minute: 19,
            second: 57,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const paymentAmount = oldCR.nextDue;
        const [assets, , profitsForFirstLossCovers] = await getAssetsAfterPnLDistribution(
            oldCR.yieldDue,
        );
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                oldCR.yieldDue,
                oldCR.nextDue.sub(oldCR.yieldDue),
                0,
                0,
                0,
                0,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                oldCR.yieldDue,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                nextDue: 0,
                yieldDue: 0,
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = {
            ...oldDD,
            ...{
                paid: oldCR.yieldDue,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(oldCR.yieldDue, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("12/1: 12th bill", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 1,
            month: 11,
            day: 1,
            hour: 3,
            minute: 47,
            second: 28,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const nextDueDate = moment.utc({
            year: nextYear + 2,
            month: 0,
            day: 1,
        });
        const daysUntilNextDue = CONSTANTS.DAYS_IN_A_MONTH;
        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            oldCR.unbilledPrincipal,
            daysUntilNextDue,
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        // This is the last period, so all principal is due.
        const nextDue = accruedYieldDue.add(oldCR.unbilledPrincipal);

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), nextDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: 0,
            nextDueDate: nextDueDate.unix(),
            nextDue: nextDue,
            yieldDue: accruedYieldDue,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: 0,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            accrued: accruedYieldDue,
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("12/5: Credit line extended for 1 more period", async function () {
        const dateOfExtension = moment.utc({
            year: nextYear + 1,
            month: 11,
            day: 5,
            hour: 0,
            minute: 21,
            second: 22,
        });
        await setNextBlockTimestamp(dateOfExtension.unix());

        const oldCC = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const numExtendedPeriods = 1;

        await expect(
            creditManagerContract
                .connect(eaServiceAccount)
                .extendRemainingPeriod(borrower.getAddress(), numExtendedPeriods),
        )
            .to.emit(creditManagerContract, "RemainingPeriodsExtended")
            .withArgs(creditHash, 0, numExtendedPeriods, await eaServiceAccount.getAddress());

        const actualCC = await creditManagerContract.getCreditConfig(creditHash);
        const expectedCC = {
            ...oldCC,
            ...{
                numOfPeriods: numPeriods + numExtendedPeriods,
            },
        };
        checkCreditConfigsMatch(actualCC, expectedCC);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                remainingPeriods: 1,
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = oldDD;
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("2/6: Bill passes the maturity date", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 2,
            month: 1,
            day: 6,
            hour: 15,
            minute: 18,
            second: 5,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const nextDueDate = moment.utc({
            year: nextYear + 2,
            month: 2,
            day: 1,
        });
        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        const daysOverdue = CONSTANTS.DAYS_IN_A_MONTH;
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            totalPrincipal,
            CONSTANTS.DAYS_IN_A_MONTH,
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        const [accruedYieldPastDue, committedYieldPastDue] = calcYieldDue(
            cc,
            totalPrincipal,
            daysOverdue,
        );
        expect(accruedYieldPastDue).to.be.gt(committedYieldPastDue);
        const lateFee = calcYield(totalPrincipal, lateFeeBps, CONSTANTS.DAYS_IN_A_MONTH + 6);
        expect(lateFee).to.be.gt(0);

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), accruedYieldDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: 0,
            nextDueDate: nextDueDate.unix(),
            nextDue: accruedYieldDue,
            yieldDue: accruedYieldDue,
            totalPastDue: oldCR.nextDue
                .add(oldCR.unbilledPrincipal)
                .add(accruedYieldPastDue)
                .add(lateFee),
            missedPeriods: 2,
            remainingPeriods: 0,
            state: CreditState.Delayed,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const lateFeeUpdatedDate = moment.utc({
            year: nextYear + 2,
            month: 1,
            day: 7,
        });
        const expectedDD = genDueDetail({
            lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
            lateFee: lateFee,
            principalPastDue: oldCR.unbilledPrincipal.add(oldCR.nextDue).sub(oldCR.yieldDue),
            yieldPastDue: oldCR.yieldDue.add(accruedYieldPastDue),
            accrued: accruedYieldDue,
            committed: committedYieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);
    });

    it("3/1: Bill refresh post maturity", async function () {
        const dateOfRefresh = moment.utc({
            year: nextYear + 2,
            month: 2,
            day: 1,
            hour: 23,
            minute: 8,
            second: 57,
        });
        await setNextBlockTimestamp(dateOfRefresh.unix());

        const nextDueDate = moment.utc({
            year: nextYear + 2,
            month: 3,
            day: 1,
        });
        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        const [accruedYieldDue, committedYieldDue] = calcYieldDue(
            cc,
            totalPrincipal,
            CONSTANTS.DAYS_IN_A_MONTH,
        );
        expect(accruedYieldDue).to.be.gt(committedYieldDue);
        const additionalLateFee = calcYield(totalPrincipal, lateFeeBps, 25);
        expect(additionalLateFee).to.be.gt(0);

        await expect(creditManagerContract.refreshCredit(borrower.address))
            .to.emit(creditContract, "BillRefreshed")
            .withArgs(creditHash, nextDueDate.unix(), accruedYieldDue);

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            ...oldCR,
            ...{
                nextDueDate: nextDueDate.unix(),
                nextDue: accruedYieldDue,
                yieldDue: accruedYieldDue,
                totalPastDue: oldCR.totalPastDue.add(oldCR.nextDue).add(additionalLateFee),
                missedPeriods: 3,
            },
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const lateFeeUpdatedDate = moment.utc({
            year: nextYear + 2,
            month: 2,
            day: 2,
        });
        const expectedDD = {
            ...oldDD,
            ...{
                lateFeeUpdatedDate: lateFeeUpdatedDate.unix(),
                lateFee: oldDD.lateFee.add(additionalLateFee),
                yieldPastDue: oldDD.yieldPastDue.add(oldCR.yieldDue),
                accrued: accruedYieldDue,
                committedYieldDue: committedYieldDue,
            },
        };
        checkDueDetailsMatch(actualDD, expectedDD);

        // Any further drawdown attempt should be blocked since the bill has gone past maturity.
        await expect(
            creditContract.connect(borrower).drawdown(borrower.getAddress(), toToken(1)),
        ).to.be.revertedWithCustomError(
            creditContract,
            "DrawdownNotAllowedInFinalPeriodAndBeyond",
        );
    });

    it("3/2: Borrower pays for all total past due", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 2,
            month: 2,
            day: 2,
            hour: 18,
            minute: 52,
            second: 43,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const totalPrincipal = getPrincipal(oldCR, oldDD);
        const additionalLateFee = calcYield(totalPrincipal, lateFeeBps, 1);
        expect(additionalLateFee).to.be.gt(0);
        const paymentAmount = oldCR.totalPastDue.add(additionalLateFee);
        const totalProfit = oldDD.yieldPastDue.add(oldDD.lateFee).add(additionalLateFee);
        const [assets, , profitsForFirstLossCovers] =
            await getAssetsAfterPnLDistribution(totalProfit);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                0,
                0,
                0,
                oldDD.yieldPastDue,
                oldDD.lateFee.add(additionalLateFee),
                oldDD.principalPastDue,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                totalProfit,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: 0,
            nextDueDate: oldCR.nextDueDate,
            nextDue: oldCR.nextDue,
            yieldDue: oldCR.yieldDue,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: 0,
            state: CreditState.GoodStanding,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            accrued: oldDD.accrued,
            committed: oldDD.committed,
        });
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(totalProfit, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });

    it("3/3: Pay off and closure of credit line", async function () {
        const dateOfPayment = moment.utc({
            year: nextYear + 2,
            month: 2,
            day: 3,
            hour: 3,
            minute: 47,
            second: 6,
        });
        await setNextBlockTimestamp(dateOfPayment.unix());

        const oldCR = await creditContract.getCreditRecord(creditHash);
        const oldDD = await creditContract.getDueDetail(creditHash);
        const paymentAmount = oldCR.nextDue;
        const totalProfit = oldCR.nextDue;
        const [assets, , profitsForFirstLossCovers] =
            await getAssetsAfterPnLDistribution(totalProfit);
        const totalProfitsForFirstLossCovers = sumBNArray(profitsForFirstLossCovers);
        expect(totalProfitsForFirstLossCovers).to.be.gt(0);
        const oldFirstLossCoverInfos = await getFirstLossCoverInfos();
        const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();

        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await expect(
            creditContract.connect(borrower).makePayment(borrower.getAddress(), paymentAmount),
        )
            .to.emit(creditContract, "PaymentMade")
            .withArgs(
                await borrower.getAddress(),
                await borrower.getAddress(),
                paymentAmount,
                oldCR.yieldDue,
                0,
                0,
                0,
                0,
                0,
                await borrower.getAddress(),
            )
            .to.emit(poolContract, "ProfitDistributed")
            .withArgs(
                totalProfit,
                assets[CONSTANTS.SENIOR_TRANCHE],
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        const newBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const newPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        expect(oldBorrowerBalance.sub(newBorrowerBalance)).to.equal(paymentAmount);
        expect(newPoolSafeBalance.sub(oldPoolSafeBalance)).to.equal(
            paymentAmount.sub(totalProfitsForFirstLossCovers),
        );

        const actualCR = await creditContract.getCreditRecord(creditHash);
        const expectedCR = {
            unbilledPrincipal: 0,
            nextDueDate: oldCR.nextDueDate,
            nextDue: 0,
            yieldDue: 0,
            totalPastDue: 0,
            missedPeriods: 0,
            remainingPeriods: 0,
            state: CreditState.Deleted,
        };
        checkCreditRecordsMatch(actualCR, expectedCR);

        const actualDD = await creditContract.getDueDetail(creditHash);
        const expectedDD = genDueDetail({
            accrued: oldDD.accrued,
            committed: oldDD.committed,
            paid: oldCR.yieldDue,
        });
        checkDueDetailsMatch(actualDD, expectedDD);

        await testPoolFees(totalProfit, oldAccruedIncomes);
        await testTranchesAssets(assets);
        await testFirstLossCoverAssets(profitsForFirstLossCovers, oldFirstLossCoverInfos);
    });
});
