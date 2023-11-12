import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
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
} from "../typechain-types";
import { PnLCalculator, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import {
    dateToTimestamp,
    getLatestBlock,
    mineNextBlockWithTimestamp,
    overrideLPConfig,
    toToken,
} from "./TestUtils";

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
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager;

describe("FixedSeniorYieldTranchePolicy Test", function () {
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
            "FixedSeniorYieldTranchePolicy",
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

    it("Should call distProfitToTranches correctly", async function () {
        const apy = 1217;
        await overrideLPConfig(poolConfigContract, poolOwner, {
            fixedSeniorYieldInBps: apy,
        });
        const deployedAssets = toToken(300_000);
        await creditContract.drawdown(ethers.constants.HashZero, deployedAssets);
        const assets = await poolContract.currentTranchesAssets();
        const profit = toToken(12463);
        const lastDate = dateToTimestamp("2023-08-01");
        const lastBlock = await getLatestBlock();
        const nextDate = lastBlock.timestamp + 10;
        await mineNextBlockWithTimestamp(nextDate);
        const newAssets = PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
            profit,
            assets,
            lastDate,
            nextDate,
            deployedAssets,
            apy,
        );
        const result = await tranchesPolicyContract.distProfitToTranches(profit, assets, lastDate);
        // TODO(jiatu): re-enable this?
        // expect(result[CONSTANTS.SENIOR_TRANCHE]).to.equal(
        //     newAssets[CONSTANTS.SENIOR_TRANCHE]
        // );
        // expect(result[CONSTANTS.JUNIOR_TRANCHE]).to.equal(
        //     newAssets[CONSTANTS.JUNIOR_TRANCHE]
        // );
    });
});
