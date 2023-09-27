import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
    CONSTANTS,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    PnLCalculator,
} from "./BaseTest";
import { toToken } from "./TestUtils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    IPoolCredit,
    MockToken,
    PoolFeeManager,
    Pool,
    PoolConfig,
    PoolSafe,
    ProfitEscrow,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress;

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
    creditContract: IPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

describe("BaseTranchesPolicy Test", function () {
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
            affiliateFirstLossCoverProfitEscrowContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract,
            creditFeeManagerContract,
            creditPnlManagerContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "FixedAprTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );

        const juniorDepositAmount = toToken(100_000);
        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(juniorDepositAmount, lender.address);
        const seniorDepositAmount = toToken(300_000);
        await seniorTrancheVaultContract
            .connect(lender)
            .deposit(seniorDepositAmount, lender.address);
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("calcTranchesAssetsForLoss", function () {
        it("Calculates the correct loss when the junior tranche loss can be covered by assets", async function () {
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.JUNIOR_TRANCHE_INDEX];

            const [newAssets, newLosses] = PnLCalculator.calcLoss(loss, assets);
            const result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);

            expect(result[0][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
                newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX],
            );
            expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
            expect(result[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
                newLosses[CONSTANTS.SENIOR_TRANCHE_INDEX],
            );
            expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                newLosses[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
        });

        it("Calculates the correct loss when junior tranche loss cannot be covered", async function () {
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].add(1);

            const [newAssets, newLosses] = PnLCalculator.calcLoss(loss, assets);
            const result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);

            expect(result[0][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
                newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX],
            );
            expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
            expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(0);
            expect(result[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
                newLosses[CONSTANTS.SENIOR_TRANCHE_INDEX],
            );
            expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                newLosses[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
            expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
        });
    });

    describe("calcTranchesAssetsForLossRecovery", function () {
        it("Calculates the correct loss when only the senior loss can be recovered", async function () {
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
                assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
            const recovery = assets[CONSTANTS.SENIOR_TRANCHE_INDEX];

            const result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);
            const [, newAssetsWithLossRecovery, newLossesWithLossRecovery] =
                PnLCalculator.calcLossRecovery(recovery, result[0], result[1]);
            const resultWithLossRecovery =
                await tranchesPolicyContract.calcTranchesAssetsForLossRecovery(
                    recovery,
                    result[0],
                    result[1],
                );
            expect(resultWithLossRecovery[0]).to.equal(0);
            expect(resultWithLossRecovery[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
                newAssetsWithLossRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX],
            );
            expect(resultWithLossRecovery[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                newAssetsWithLossRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
            expect(resultWithLossRecovery[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(0);
            expect(resultWithLossRecovery[2][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
                newLossesWithLossRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                newLossesWithLossRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
        });

        it("Calculates the correct loss when both the senior and junior loss can be recovered", async function () {
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
                assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
            const recovery = loss;

            const result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);
            const [, newAssetsWithLossRecovery, newLossesWithLossRecovery] =
                PnLCalculator.calcLossRecovery(recovery, result[0], result[1]);
            const resultWithLossRecovery =
                await tranchesPolicyContract.calcTranchesAssetsForLossRecovery(
                    recovery,
                    result[0],
                    result[1],
                );
            expect(resultWithLossRecovery[0]).to.equal(0);
            expect(resultWithLossRecovery[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
                newAssetsWithLossRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX],
            );
            expect(resultWithLossRecovery[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                newAssetsWithLossRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
            expect(resultWithLossRecovery[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
                assets[CONSTANTS.SENIOR_TRANCHE_INDEX],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
                newLossesWithLossRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
                newLossesWithLossRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(0);
        });
    });
});
