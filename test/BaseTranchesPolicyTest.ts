import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditFeeManager,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    IPoolCredit,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    ProfitEscrow,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import {
    CONSTANTS,
    PnLCalculator,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
} from "./BaseTest";
import { getFirstLossCoverInfo, toToken } from "./TestUtils";

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
    creditFeeManagerContract: CreditFeeManager;

describe("BaseTranchesPolicy Tests", function () {
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
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "FixedSeniorYieldTranchePolicy",
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

    describe("distLossToTranches", function () {
        it("Calculates the correct loss when the junior tranche loss can be covered by assets", async function () {
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.JUNIOR_TRANCHE];

            const firstLossCoverInfos = await Promise.all(
                [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                    async (contract) => await getFirstLossCoverInfo(contract, poolConfigContract),
                ),
            );
            const [newAssets, newLosses] = await PnLCalculator.calcLoss(
                loss,
                assets,
                firstLossCoverInfos,
            );
            const result = await tranchesPolicyContract.distLossToTranches(loss, assets);

            expect(result[0][CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(result[0][CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.JUNIOR_TRANCHE],
            );
            expect(result[1][CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newLosses[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(result[1][CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newLosses[CONSTANTS.JUNIOR_TRANCHE],
            );
        });

        it("Calculates the correct loss when junior tranche loss cannot be covered", async function () {
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.JUNIOR_TRANCHE].add(1);

            const firstLossCoverInfos = await Promise.all(
                [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                    async (contract) => await getFirstLossCoverInfo(contract, poolConfigContract),
                ),
            );
            const [newAssets, newLosses] = await PnLCalculator.calcLoss(
                loss,
                assets,
                firstLossCoverInfos,
            );
            const result = await tranchesPolicyContract.distLossToTranches(loss, assets);

            expect(result[0][CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(result[0][CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.JUNIOR_TRANCHE],
            );
            expect(result[0][CONSTANTS.JUNIOR_TRANCHE]).to.equal(0);
            expect(result[1][CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newLosses[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(result[1][CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newLosses[CONSTANTS.JUNIOR_TRANCHE],
            );
            expect(result[1][CONSTANTS.JUNIOR_TRANCHE]).to.equal(assets[CONSTANTS.JUNIOR_TRANCHE]);
        });
    });

    describe("distLossRecoveryToTranches", function () {
        it("Calculates the correct loss when only the senior loss can be recovered", async function () {
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.SENIOR_TRANCHE].add(assets[CONSTANTS.JUNIOR_TRANCHE]);
            const recovery = assets[CONSTANTS.SENIOR_TRANCHE];

            const [assetsAfterLosses, losses] = await tranchesPolicyContract.distLossToTranches(
                loss,
                assets,
            );
            const [, newAssetsWithLossRecovery, newLossesWithLossRecovery] =
                await PnLCalculator.calcLossRecovery(recovery, assetsAfterLosses, losses, [
                    BN.from(0),
                    BN.from(0),
                ]);
            const resultWithLossRecovery = await tranchesPolicyContract.distLossRecoveryToTranches(
                recovery,
                assetsAfterLosses,
                losses,
            );
            expect(resultWithLossRecovery[0]).to.equal(0);
            expect(resultWithLossRecovery[1][CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newAssetsWithLossRecovery[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(resultWithLossRecovery[1][CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newAssetsWithLossRecovery[CONSTANTS.JUNIOR_TRANCHE],
            );
            expect(resultWithLossRecovery[1][CONSTANTS.JUNIOR_TRANCHE]).to.equal(0);
            expect(resultWithLossRecovery[2][CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newLossesWithLossRecovery[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newLossesWithLossRecovery[CONSTANTS.JUNIOR_TRANCHE],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );
        });

        it("Calculates the correct loss when both the senior and junior loss can be recovered", async function () {
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.SENIOR_TRANCHE].add(assets[CONSTANTS.JUNIOR_TRANCHE]);
            const recovery = loss;

            const [assetsAfterLosses, losses] = await tranchesPolicyContract.distLossToTranches(
                loss,
                assets,
            );
            const [, newAssetsWithLossRecovery, newLossesWithLossRecovery] =
                await PnLCalculator.calcLossRecovery(recovery, assetsAfterLosses, losses, [
                    BN.from(0),
                    BN.from(0),
                ]);
            const resultWithLossRecovery = await tranchesPolicyContract.distLossRecoveryToTranches(
                recovery,
                assetsAfterLosses,
                losses,
            );
            expect(resultWithLossRecovery[0]).to.equal(0);
            expect(resultWithLossRecovery[1][CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newAssetsWithLossRecovery[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(resultWithLossRecovery[1][CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newAssetsWithLossRecovery[CONSTANTS.JUNIOR_TRANCHE],
            );
            expect(resultWithLossRecovery[1][CONSTANTS.SENIOR_TRANCHE]).to.equal(
                assets[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newLossesWithLossRecovery[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newLossesWithLossRecovery[CONSTANTS.JUNIOR_TRANCHE],
            );
            expect(resultWithLossRecovery[2][CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        });
    });
});
