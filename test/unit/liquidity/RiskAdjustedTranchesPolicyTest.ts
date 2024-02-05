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
    PnLCalculator,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
} from "../../BaseTest";
import { overrideLPConfig, toToken } from "../../TestUtils";
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
let lender: SignerWithAddress;

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
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager;

describe("RiskAdjustedTranchesPolicy Test", function () {
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
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            "CreditLineManager",
            evaluationAgent,
            treasury,
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );

        const juniorDepositAmount = toToken(100_000);
        await juniorTrancheVaultContract.connect(lender).deposit(juniorDepositAmount);
        const seniorDepositAmount = toToken(300_000);
        await seniorTrancheVaultContract.connect(lender).deposit(seniorDepositAmount);
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should not allow non-pool to call distProfitToTranches", async function () {
        const assets = await poolContract.currentTranchesAssets();
        await expect(
            tranchesPolicyContract.distProfitToTranches(0, [...assets]),
        ).to.be.revertedWithCustomError(
            tranchesPolicyContract,
            "AuthorizedContractCallerRequired",
        );
    });

    it("Should call distProfitToTranches correctly", async function () {
        const adjustment = 8000;
        await overrideLPConfig(poolConfigContract, poolOwner, {
            tranchesRiskAdjustmentInBps: adjustment,
        });

        const assets = await poolContract.currentTranchesAssets();
        const profit = toToken(14837);

        const newAssets = PnLCalculator.calcProfitForRiskAdjustedPolicy(
            profit,
            assets,
            BN.from(adjustment),
        );
        await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
        await tranchesPolicyContract.connect(poolOwner).updatePoolConfigData();
        const result = await tranchesPolicyContract.callStatic.distProfitToTranches(profit, [
            ...assets,
        ]);
        expect(result.profitsForTrancheVault[CONSTANTS.SENIOR_TRANCHE]).to.equal(
            newAssets[CONSTANTS.SENIOR_TRANCHE].sub(assets[CONSTANTS.SENIOR_TRANCHE]),
        );
        let allProfit = result.profitsForTrancheVault[CONSTANTS.SENIOR_TRANCHE].add(
            result.profitsForTrancheVault[CONSTANTS.JUNIOR_TRANCHE],
        );
        result.profitsForFirstLossCover.forEach((profit) => {
            allProfit = allProfit.add(profit);
        });
        expect(allProfit).to.equal(profit);
    });
});
