import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import moment from "moment";
import {
    CONSTANTS,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    PnLCalculator,
} from "./BaseTest";
import {
    getLatestBlock,
    mineNextBlockWithTimestamp,
    overrideLPConfig,
    toToken,
} from "./TestUtils";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    LossCoverer,
    MockPoolCredit,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";

let defaultDeployer: HardhatEthersSigner,
    protocolOwner: HardhatEthersSigner,
    treasury: HardhatEthersSigner,
    eaServiceAccount: HardhatEthersSigner,
    pdsServiceAccount: HardhatEthersSigner;
let poolOwner: HardhatEthersSigner,
    poolOwnerTreasury: HardhatEthersSigner,
    evaluationAgent: HardhatEthersSigner,
    poolOperator: HardhatEthersSigner;
let lender: HardhatEthersSigner;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    platformFeeManagerContract: PlatformFeeManager,
    poolVaultContract: PoolVault,
    calendarContract: Calendar,
    poolOwnerAndEAFirstLossCoverContract: LossCoverer,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

describe("FixedAprTranchesPolicy Test", function () {
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
            platformFeeManagerContract,
            poolVaultContract,
            calendarContract,
            poolOwnerAndEAFirstLossCoverContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
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

        let juniorDepositAmount = toToken(100_000);
        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(juniorDepositAmount, lender.address);
        let seniorDepositAmount = toToken(300_000);
        await seniorTrancheVaultContract
            .connect(lender)
            .deposit(seniorDepositAmount, lender.address);
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should call calcTranchesAssetsForProfit correctly", async function () {
        const apy = 1217n;

        const lpConfig = await poolConfigContract.getLPConfig();
        const newLpConfig = overrideLPConfig(lpConfig, { fixedSeniorYieldInBps: apy });
        await poolConfigContract.connect(poolOwner).setLPConfig(newLpConfig);
        let deployedAssets = toToken(300_000);
        await creditContract.drawdown(ethers.ZeroHash, deployedAssets);

        let assets = await poolContract.currentTranchesAssets();
        let profit = toToken(12463);
        let lastDate = moment.utc("2023-08-01").unix();

        let lastBlock = await getLatestBlock();
        let nextDate = lastBlock!.timestamp + 10;
        await mineNextBlockWithTimestamp(nextDate);
        let newAssets = PnLCalculator.calcProfitForFixedAprPolicy(
            profit,
            assets,
            lastDate,
            nextDate,
            deployedAssets,
            apy,
        );
        let result = await tranchesPolicyContract.calcTranchesAssetsForProfit(
            profit,
            [...assets],
            lastDate,
        );
        // expect(result[CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
        //     newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX],
        // );
        // expect(result[CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
        //     newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
        // );
    });
});
