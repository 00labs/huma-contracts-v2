import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployPoolContracts, deployProtocolContracts } from "./BaseTest";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
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
    ProfitEscrow,
} from "../typechain-types";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress,
    lender: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    platformFeeManagerContract: PlatformFeeManager,
    poolVaultContract: PoolVault,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    affiliateFirstLossCoverProfitEscrowContract: ProfitEscrow,
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
            borrowerFirstLossCoverContract,
            affiliateFirstLossCoverContract,
            affiliateFirstLossCoverProfitEscrowContract,
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
            .withArgs(poolConfigContract.address);

        expect(await juniorTrancheVaultContract.poolVault()).to.equal(defaultDeployer.address);
    });

    it("Should not set pool config to empty address", async function () {
        await expect(
            seniorTrancheVaultContract.setPoolConfig(ethers.constants.AddressZero),
        ).to.be.revertedWithCustomError(seniorTrancheVaultContract, "zeroAddressProvided");
    });

    it("Should not allow non-poolOwner to set new pool config", async function () {
        await expect(
            seniorTrancheVaultContract.setPoolConfig(poolConfigContract.address),
        ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
    });

    it("Should set new pool config", async function () {
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        const newPoolConfigContract = await PoolConfig.deploy();
        await newPoolConfigContract.deployed();

        await newPoolConfigContract.initialize("Test New Pool", [
            humaConfigContract.address,
            mockTokenContract.address,
            calendarContract.address,
            tranchesPolicyContract.address,
            calendarContract.address,
            platformFeeManagerContract.address,
            tranchesPolicyContract.address,
            mockTokenContract.address,
            seniorTrancheVaultContract.address,
            juniorTrancheVaultContract.address,
            creditContract.address,
            creditFeeManagerContract.address,
            creditPnlManagerContract.address,
        ]);

        await expect(
            seniorTrancheVaultContract
                .connect(poolOwner)
                .setPoolConfig(newPoolConfigContract.address),
        )
            .to.emit(seniorTrancheVaultContract, "PoolConfigChanged")
            .withArgs(newPoolConfigContract.address, poolConfigContract.address);

        expect(await seniorTrancheVaultContract.pool()).to.equal(tranchesPolicyContract.address);
        expect(await seniorTrancheVaultContract.poolVault()).to.equal(calendarContract.address);
        expect(await seniorTrancheVaultContract.epochManager()).to.equal(
            mockTokenContract.address,
        );
    });
});
