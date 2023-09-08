import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployPoolContracts, deployProtocolContracts } from "./BaseTest";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    FirstLossCover,
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
    poolOperator: HardhatEthersSigner,
    lender: HardhatEthersSigner;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    platformFeeManagerContract: PlatformFeeManager,
    poolVaultContract: PoolVault,
    calendarContract: Calendar,
    poolOwnerAndEAFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

describe("PoolConfigCache Test", function () {
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
        ] = await deployPoolContracts(
            humaConfigContract,
            mockTokenContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should not allow non-poolOwner to update pool config cache", async function () {
        await expect(
            juniorTrancheVaultContract.updatePoolConfigData(),
        ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
    });

    it("Should update pool config cache", async function () {
        await poolConfigContract.connect(poolOwner).setPoolVault(defaultDeployer.address);

        await expect(juniorTrancheVaultContract.connect(poolOwner).updatePoolConfigData())
            .to.emit(juniorTrancheVaultContract, "PoolConfigCacheUpdated")
            .withArgs(await poolConfigContract.getAddress());

        expect(await juniorTrancheVaultContract.poolVault()).to.equal(defaultDeployer.address);
    });

    it("Should not set pool config to empty address", async function () {
        await expect(
            seniorTrancheVaultContract.setPoolConfig(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(seniorTrancheVaultContract, "zeroAddressProvided");
    });

    it("Should not allow non-poolOwner to set new pool config", async function () {
        await expect(
            seniorTrancheVaultContract.setPoolConfig(poolConfigContract.getAddress()),
        ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
    });

    it("Should set new pool config", async function () {
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        const newPoolConfigContract = await PoolConfig.deploy();
        await newPoolConfigContract.waitForDeployment();

        await newPoolConfigContract.initialize("Test New Pool", [
            humaConfigContract.getAddress(),
            mockTokenContract.getAddress(),
            platformFeeManagerContract.getAddress(),
            calendarContract.getAddress(),
            calendarContract.getAddress(),
            poolOwnerAndEAFirstLossCoverContract.getAddress(),
            tranchesPolicyContract.getAddress(),
            tranchesPolicyContract.getAddress(),
            mockTokenContract.getAddress(),
            seniorTrancheVaultContract.getAddress(),
            juniorTrancheVaultContract.getAddress(),
            creditContract.getAddress(),
            creditFeeManagerContract.getAddress(),
            creditPnlManagerContract.getAddress(),
        ]);

        await expect(
            seniorTrancheVaultContract
                .connect(poolOwner)
                .setPoolConfig(newPoolConfigContract.getAddress()),
        )
            .to.emit(seniorTrancheVaultContract, "PoolConfigChanged")
            .withArgs(
                await newPoolConfigContract.getAddress(),
                await poolConfigContract.getAddress(),
            );

        expect(await seniorTrancheVaultContract.pool()).to.equal(
            await tranchesPolicyContract.getAddress(),
        );
        expect(await seniorTrancheVaultContract.poolVault()).to.equal(
            await calendarContract.getAddress(),
        );
        expect(await seniorTrancheVaultContract.epochManager()).to.equal(
            await mockTokenContract.getAddress(),
        );
    });
});
