import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    BorrowerLevelCreditManager,
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
    FeeStructureStruct,
    FirstLossCoverConfigStruct,
    FrontLoadingFeesStructureStruct,
    LPConfigStruct,
    PoolSettingsStructOutput,
} from "../../../typechain-types/contracts/common/PoolConfig.sol/PoolConfig";
import {
    CONSTANTS,
    PayPeriodDuration,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    deployProxyContract,
} from "../../BaseTest";
import {
    getMinFirstLossCoverRequirement,
    getMinLiquidityRequirementForEA,
    getMinLiquidityRequirementForPoolOwner,
    overrideFirstLossCoverConfig,
    toToken,
} from "../../TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    evaluationAgent2: SignerWithAddress,
    poolOperator: SignerWithAddress,
    protocolTreasury: SignerWithAddress,
    regularUser: SignerWithAddress;

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
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: BorrowerLevelCreditManager;

describe("PoolConfig Tests", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            protocolTreasury,
            eaServiceAccount,
            sentinelServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            evaluationAgent2,
            poolOperator,
            regularUser,
        ] = await ethers.getSigners();
    });

    describe("Pool config initialization", function () {
        async function deployPoolConfigContract() {
            [, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                protocolTreasury,
                eaServiceAccount,
                sentinelServiceAccount,
                poolOwner,
            );
            const PoolConfig = await ethers.getContractFactory("PoolConfig");
            poolConfigContract = (await deployProxyContract(PoolConfig)) as PoolConfig;

            const PoolFeeManager = await ethers.getContractFactory("PoolFeeManager");
            poolFeeManagerContract = (await deployProxyContract(PoolFeeManager)) as PoolFeeManager;

            const PoolSafe = await ethers.getContractFactory("PoolSafe");
            poolSafeContract = (await deployProxyContract(PoolSafe)) as PoolSafe;

            const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
            borrowerFirstLossCoverContract = (await deployProxyContract(
                FirstLossCover,
            )) as FirstLossCover;
            affiliateFirstLossCoverContract = (await deployProxyContract(
                FirstLossCover,
            )) as FirstLossCover;

            const TranchesPolicy = await ethers.getContractFactory("RiskAdjustedTranchesPolicy");
            tranchesPolicyContract = (await deployProxyContract(
                TranchesPolicy,
            )) as RiskAdjustedTranchesPolicy;

            const Pool = await ethers.getContractFactory("Pool");
            poolContract = (await deployProxyContract(Pool)) as Pool;

            const EpochManager = await ethers.getContractFactory("EpochManager");
            epochManagerContract = await EpochManager.deploy();
            await epochManagerContract.deployed();

            const TrancheVault = await ethers.getContractFactory("TrancheVault");
            seniorTrancheVaultContract = (await deployProxyContract(TrancheVault)) as TrancheVault;
            juniorTrancheVaultContract = (await deployProxyContract(TrancheVault)) as TrancheVault;

            const Calendar = await ethers.getContractFactory("Calendar");
            calendarContract = await Calendar.deploy();
            await calendarContract.deployed();

            const Credit = await ethers.getContractFactory("MockPoolCredit");
            creditContract = (await deployProxyContract(Credit)) as MockPoolCredit;

            const CreditDueManager = await ethers.getContractFactory("CreditDueManager");
            creditDueManagerContract = (await deployProxyContract(
                CreditDueManager,
            )) as CreditDueManager;

            const CreditManager = await ethers.getContractFactory("BorrowerLevelCreditManager");
            creditManagerContract = (await deployProxyContract(
                CreditManager,
            )) as BorrowerLevelCreditManager;
        }

        beforeEach(async function () {
            await loadFixture(deployPoolConfigContract);
        });

        it("Should initialize successfully and sets default values", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .initialize("Base Credit Pool", [
                    humaConfigContract.address,
                    mockTokenContract.address,
                    calendarContract.address,
                    poolContract.address,
                    poolSafeContract.address,
                    poolFeeManagerContract.address,
                    tranchesPolicyContract.address,
                    epochManagerContract.address,
                    seniorTrancheVaultContract.address,
                    juniorTrancheVaultContract.address,
                    creditContract.address,
                    creditDueManagerContract.address,
                    creditManagerContract.address,
                ]);

            const poolSettings = await poolConfigContract.getPoolSettings();
            expect(poolSettings.payPeriodDuration).to.equal(PayPeriodDuration.Monthly);
            expect(poolSettings.advanceRateInBps).to.equal(8000);
            expect(poolSettings.latePaymentGracePeriodInDays).to.equal(5);
            expect(poolSettings.defaultGracePeriodInDays).to.equal(10);

            const adminRnR = await poolConfigContract.getAdminRnR();
            expect(adminRnR.rewardRateInBpsForEA).to.equal(300);
            expect(adminRnR.rewardRateInBpsForPoolOwner).to.equal(200);
            expect(adminRnR.liquidityRateInBpsByEA).to.equal(200);
            expect(adminRnR.liquidityRateInBpsByPoolOwner).to.equal(200);

            const lpConfig = await poolConfigContract.getLPConfig();
            expect(lpConfig.maxSeniorJuniorRatio).to.equal(4);
        });

        it("Should reject call to initialize() if the proxy is deployed with calldata", async function () {
            const PoolConfig = await ethers.getContractFactory("PoolConfig");
            const poolConfigContractNew = (await deployProxyContract(PoolConfig, "initialize", [
                "Base Credit Pool",
                [
                    humaConfigContract.address,
                    mockTokenContract.address,
                    poolFeeManagerContract.address,
                    poolSafeContract.address,
                    calendarContract.address,
                    tranchesPolicyContract.address,
                    poolContract.address,
                    epochManagerContract.address,
                    seniorTrancheVaultContract.address,
                    juniorTrancheVaultContract.address,
                    creditContract.address,
                    creditDueManagerContract.address,
                    creditManagerContract.address,
                ],
            ])) as PoolConfig;
            await expect(
                poolConfigContractNew
                    .connect(regularUser)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWith("Initializable: contract is already initialized");
        });

        it("Should reject zero address for HumaConfig", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        ethers.constants.AddressZero,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject invalid underlying tokens", async function () {
            await humaConfigContract
                .connect(protocolOwner)
                .setLiquidityAsset(mockTokenContract.address, false);
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        humaConfigContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "underlyingTokenNotApprovedForHumaProtocol",
            );
        });

        it("Should reject zero address for poolFeeManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        ethers.constants.AddressZero,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for poolSafe", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        ethers.constants.AddressZero,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for calendar", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        ethers.constants.AddressZero,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for poolOwnerOrEAFirstLossCover", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        ethers.constants.AddressZero,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for tranchePolicy", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        ethers.constants.AddressZero,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for the pool", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        ethers.constants.AddressZero,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for epochManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        ethers.constants.AddressZero,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for seniorTranche", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        ethers.constants.AddressZero,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for juniorTranche", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        ethers.constants.AddressZero,
                        creditContract.address,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject wrong tranche indices for juniorTranche", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .initialize("Base Credit Pool", [
                    humaConfigContract.address,
                    mockTokenContract.address,
                    poolFeeManagerContract.address,
                    poolSafeContract.address,
                    calendarContract.address,
                    tranchesPolicyContract.address,
                    poolContract.address,
                    epochManagerContract.address,
                    seniorTrancheVaultContract.address,
                    juniorTrancheVaultContract.address,
                    creditContract.address,
                    creditDueManagerContract.address,
                    creditManagerContract.address,
                ]);
            await expect(
                juniorTrancheVaultContract["initialize(string,string,address,uint8)"](
                    "Junior Tranche Vault",
                    "JTV",
                    poolConfigContract.address,
                    CONSTANTS.JUNIOR_TRANCHE + 1,
                ),
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "invalidTrancheIndex");
        });

        it("Should reject zero address for credit", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        ethers.constants.AddressZero,
                        creditDueManagerContract.address,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for creditDueManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        ethers.constants.AddressZero,
                        creditManagerContract.address,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject zero address for creditManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditManagerContract.address,
                        ethers.constants.AddressZero,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });

        it("Should reject repeated call to initialize()", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .initialize("Base Credit Pool", [
                    humaConfigContract.address,
                    mockTokenContract.address,
                    poolFeeManagerContract.address,
                    poolSafeContract.address,
                    calendarContract.address,
                    tranchesPolicyContract.address,
                    poolContract.address,
                    epochManagerContract.address,
                    seniorTrancheVaultContract.address,
                    juniorTrancheVaultContract.address,
                    creditContract.address,
                    creditDueManagerContract.address,
                    creditManagerContract.address,
                ]);
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        poolFeeManagerContract.address,
                        poolSafeContract.address,
                        calendarContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditDueManagerContract.address,
                    ]),
            ).to.be.revertedWith("Initializable: contract is already initialized");
        });
    });

    describe("Pool config admin functions", function () {
        async function deployAndSetupContracts() {
            [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                protocolTreasury,
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
            ] = await deployAndSetupPoolContracts(
                humaConfigContract,
                mockTokenContract,
                eaNFTContract,
                "FixedSeniorYieldTranchePolicy",
                defaultDeployer,
                poolOwner,
                "MockPoolCredit",
                "BorrowerLevelCreditManager",
                evaluationAgent,
                poolOwnerTreasury,
                poolOperator,
                [regularUser, evaluationAgent2],
                false,
            );
        }

        beforeEach(async function () {
            await loadFixture(deployAndSetupContracts);
        });

        describe("setPoolOwnerRewardsAndLiquidity", function () {
            const rewardsRate = 100;
            const liquidityRate = 200;

            it("Should allow setting rewards and liquidity by the pool owner", async function () {
                const tx = await poolConfigContract
                    .connect(poolOwner)
                    .setPoolOwnerRewardsAndLiquidity(rewardsRate, liquidityRate);
                const adminRnR = await poolConfigContract.getAdminRnR();
                expect(adminRnR.rewardRateInBpsForPoolOwner).to.equal(rewardsRate);
                expect(adminRnR.liquidityRateInBpsByPoolOwner).to.equal(liquidityRate);
                await expect(tx)
                    .to.emit(poolConfigContract, "PoolOwnerRewardsAndLiquidityChanged")
                    .withArgs(rewardsRate, liquidityRate, poolOwner.address);
            });

            it("Should allow setting rewards and liquidity by the Huma master admin", async function () {
                const tx = await poolConfigContract
                    .connect(protocolOwner)
                    .setPoolOwnerRewardsAndLiquidity(rewardsRate, liquidityRate);
                const adminRnR = await poolConfigContract.getAdminRnR();
                expect(adminRnR.rewardRateInBpsForPoolOwner).to.equal(rewardsRate);
                expect(adminRnR.liquidityRateInBpsByPoolOwner).to.equal(liquidityRate);
                await expect(tx)
                    .to.emit(poolConfigContract, "PoolOwnerRewardsAndLiquidityChanged")
                    .withArgs(rewardsRate, liquidityRate, protocolOwner.address);
            });

            it("Should not allow other users to set the rates", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolOwnerRewardsAndLiquidity(rewardsRate, liquidityRate),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should fail if reward rate exceeds 100%", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolOwnerRewardsAndLiquidity(15000, liquidityRate),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });

            it("Should fail if liquidity rate exceeds 100%", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolOwnerRewardsAndLiquidity(rewardsRate, 15000),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });

            it("Should fail if the combined reward rate of the pool owner and EA exceeds 100%", async function () {
                const adminRnR = await poolConfigContract.getAdminRnR();
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolOwnerRewardsAndLiquidity(
                            CONSTANTS.BP_FACTOR.sub(adminRnR.rewardRateInBpsForEA).add(1),
                            liquidityRate,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "adminRewardRateTooHigh");
            });
        });

        describe("setEARewardsAndLiquidity", function () {
            const rewardsRate = 100;
            const liquidityRate = 200;

            it("Should allow setting rewards and liquidity by the pool owner", async function () {
                const tx = await poolConfigContract
                    .connect(poolOwner)
                    .setEARewardsAndLiquidity(rewardsRate, liquidityRate);
                const adminRnR = await poolConfigContract.getAdminRnR();
                expect(adminRnR.rewardRateInBpsForEA).to.equal(rewardsRate);
                expect(adminRnR.liquidityRateInBpsByEA).to.equal(liquidityRate);
                await expect(tx)
                    .to.emit(poolConfigContract, "EARewardsAndLiquidityChanged")
                    .withArgs(rewardsRate, liquidityRate, poolOwner.address);
            });

            it("Should allow setting rewards and liquidity by the Huma master admin", async function () {
                const tx = await poolConfigContract
                    .connect(protocolOwner)
                    .setEARewardsAndLiquidity(rewardsRate, liquidityRate);
                const adminRnR = await poolConfigContract.getAdminRnR();
                expect(adminRnR.rewardRateInBpsForEA).to.equal(rewardsRate);
                expect(adminRnR.liquidityRateInBpsByEA).to.equal(liquidityRate);
                await expect(tx)
                    .to.emit(poolConfigContract, "EARewardsAndLiquidityChanged")
                    .withArgs(rewardsRate, liquidityRate, protocolOwner.address);
            });

            it("Should not allow other users to set the rates", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setEARewardsAndLiquidity(rewardsRate, liquidityRate),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should fail if reward rate exceeds 100%", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEARewardsAndLiquidity(15000, liquidityRate),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });

            it("Should fail if liquidity rate exceeds 100%", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEARewardsAndLiquidity(rewardsRate, 15000),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });

            it("Should fail if the combined reward rate of the pool owner and EA exceeds 100%", async function () {
                const adminRnR = await poolConfigContract.getAdminRnR();
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEARewardsAndLiquidity(
                            CONSTANTS.BP_FACTOR.sub(adminRnR.rewardRateInBpsForPoolOwner).add(1),
                            liquidityRate,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "adminRewardRateTooHigh");
            });
        });

        describe("setEvaluationAgent", function () {
            let newNFTTokenId: string;
            let minFirstLossCoverRequirement: BN, minLiquidity: BN;

            beforeEach(async function () {
                const tx = await eaNFTContract.mintNFT(evaluationAgent2.address);
                const receipt = await tx.wait();
                for (const evt of receipt.events!) {
                    if (evt.event === "NFTGenerated") {
                        newNFTTokenId = evt.args!.tokenId;
                    }
                }

                // Set the EA to be a cover provider.
                await affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(evaluationAgent2.getAddress());

                minFirstLossCoverRequirement = await getMinFirstLossCoverRequirement(
                    affiliateFirstLossCoverContract,
                    poolConfigContract,
                );
                minLiquidity = await getMinLiquidityRequirementForEA(poolConfigContract);
            });

            it("Should allow the evaluation agent to be set and replaced", async function () {
                let eaNFTTokenId;
                const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
                const receipt = await tx.wait();
                for (const evt of receipt.events!) {
                    if (evt.event === "NFTGenerated") {
                        eaNFTTokenId = evt.args!.tokenId;
                    }
                }
                const adminRnR = await poolConfigContract.getAdminRnR();
                const lpConfig = await poolConfigContract.getLPConfig();
                const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByEA)
                    .mul(lpConfig.liquidityCap)
                    .div(CONSTANTS.BP_FACTOR);
                await juniorTrancheVaultContract
                    .connect(poolOwner)
                    .addApprovedLender(evaluationAgent.getAddress(), true);
                await juniorTrancheVaultContract
                    .connect(evaluationAgent)
                    .deposit(evaluationAgentLiquidity, evaluationAgent.getAddress());
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address),
                )
                    .to.emit(poolConfigContract, "EvaluationAgentChanged")
                    .withArgs(
                        ethers.constants.AddressZero,
                        evaluationAgent.address,
                        eaNFTTokenId,
                        poolOwner.address,
                    );
                expect(await poolConfigContract.evaluationAgent()).to.equal(
                    evaluationAgent.address,
                );
                expect(await poolConfigContract.evaluationAgentId()).to.equal(eaNFTTokenId);

                // Then replace it with another EA.
                // Give the new EA some tokens to use as the first loss cover and junior tranche liquidity.
                await mockTokenContract.mint(
                    evaluationAgent2.address,
                    minFirstLossCoverRequirement.add(minLiquidity),
                );
                await mockTokenContract
                    .connect(evaluationAgent2)
                    .approve(
                        affiliateFirstLossCoverContract.address,
                        minFirstLossCoverRequirement.add(minLiquidity),
                    );
                await juniorTrancheVaultContract
                    .connect(evaluationAgent2)
                    .deposit(minLiquidity, evaluationAgent2.address);

                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(newNFTTokenId, evaluationAgent2.address),
                )
                    .to.emit(poolConfigContract, "EvaluationAgentChanged")
                    .withArgs(
                        evaluationAgent.address,
                        evaluationAgent2.address,
                        newNFTTokenId,
                        poolOwner.address,
                    );
                expect(await poolConfigContract.evaluationAgent()).to.equal(
                    evaluationAgent2.address,
                );
                expect(await poolConfigContract.evaluationAgentId()).to.equal(newNFTTokenId);
            });

            it("Should reject zero address EA", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(newNFTTokenId, ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });

            it("Should not allow non-pool owners or Huma master admin to set the EA", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setEvaluationAgent(newNFTTokenId, evaluationAgent2.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject when the proposed new EA does not own the EA NFT", async function () {
                let yetAnotherNFTTokenId;
                const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
                const receipt = await tx.wait();
                for (const evt of receipt.events!) {
                    if (evt.event === "NFTGenerated") {
                        yetAnotherNFTTokenId = evt.args!.tokenId;
                    }
                }

                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(yetAnotherNFTTokenId, evaluationAgent2.address),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "proposedEADoesNotOwnProvidedEANFT",
                );
            });

            it("Should reject the new EA if the first loss cover requirement is not met", async function () {
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                await overrideFirstLossCoverConfig(
                    affiliateFirstLossCoverContract,
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        minLiquidity: coverTotalAssets.add(toToken(1)),
                    },
                );

                await mockTokenContract.mint(
                    evaluationAgent2.address,
                    minFirstLossCoverRequirement.add(minLiquidity),
                );
                await mockTokenContract
                    .connect(evaluationAgent2)
                    .approve(
                        affiliateFirstLossCoverContract.address,
                        minFirstLossCoverRequirement.add(minLiquidity),
                    );
                await juniorTrancheVaultContract
                    .connect(evaluationAgent2)
                    .deposit(minLiquidity, evaluationAgent2.address);

                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(newNFTTokenId, evaluationAgent2.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");
            });

            it("Should reject when the new evaluation agent has not met the liquidity requirement", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEvaluationAgent(newNFTTokenId, evaluationAgent2.address),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "evaluationAgentNotEnoughLiquidity",
                );
            });
        });

        describe("setPoolFeeManager", function () {
            it("Should allow pool owner to set the fee manager successfully", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolFeeManager(poolFeeManagerContract.address),
                )
                    .to.emit(poolConfigContract, "PoolFeeManagerChanged")
                    .withArgs(poolFeeManagerContract.address, poolOwner.address);
                expect(await poolConfigContract.poolFeeManager()).to.equal(
                    poolFeeManagerContract.address,
                );
            });

            it("Should allow protocol owner to set the fee manager successfully", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolFeeManager(poolFeeManagerContract.address),
                )
                    .to.emit(poolConfigContract, "PoolFeeManagerChanged")
                    .withArgs(poolFeeManagerContract.address, protocolOwner.address);
                expect(await poolConfigContract.poolFeeManager()).to.equal(
                    poolFeeManagerContract.address,
                );
            });

            it("Should reject non-owner and admin to call setPoolFeeManager", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolFeeManager(poolFeeManagerContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject fee manager with zero address", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolFeeManager(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setHumaConfig", function () {
            it("Should allow the pool owner to set Huma config", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setHumaConfig(humaConfigContract.address),
                )
                    .to.emit(poolConfigContract, "HumaConfigChanged")
                    .withArgs(humaConfigContract.address, poolOwner.address);
                expect(await poolConfigContract.humaConfig()).to.equal(humaConfigContract.address);
            });

            it("Should allow the Huma master admin to set Huma config", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setHumaConfig(humaConfigContract.address),
                )
                    .to.emit(poolConfigContract, "HumaConfigChanged")
                    .withArgs(humaConfigContract.address, protocolOwner.address);
                expect(await poolConfigContract.humaConfig()).to.equal(humaConfigContract.address);
            });

            it("Should reject non-owner or admin to call setHumaConfig", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setHumaConfig(humaConfigContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject Huma config with zero address", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setHumaConfig(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setPool", function () {
            it("Should allow the pool owner to set the pool", async function () {
                await expect(poolConfigContract.connect(poolOwner).setPool(poolContract.address))
                    .to.emit(poolConfigContract, "PoolChanged")
                    .withArgs(poolContract.address, poolOwner.address);
                expect(await poolConfigContract.pool()).to.equal(poolContract.address);
            });

            it("Should allow the Huma master admin to set the pool", async function () {
                await expect(
                    poolConfigContract.connect(protocolOwner).setPool(poolContract.address),
                )
                    .to.emit(poolConfigContract, "PoolChanged")
                    .withArgs(poolContract.address, protocolOwner.address);
                expect(await poolConfigContract.pool()).to.equal(poolContract.address);
            });

            it("Should reject non-owner or admin to set the pool", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setPool(poolContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should reject pools with zero address", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setPool(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setPoolName", function () {
            const poolName = "Test pool";

            it("Should allow the pool owner to set pool name", async function () {
                await expect(poolConfigContract.connect(poolOwner).setPoolName(poolName))
                    .to.emit(poolConfigContract, "PoolNameChanged")
                    .withArgs(poolName, poolOwner.address);
                expect(await poolConfigContract.poolName()).to.equal(poolName);
            });

            it("Should allow the Huma master admin to set pool name", async function () {
                await expect(poolConfigContract.connect(protocolOwner).setPoolName(poolName))
                    .to.emit(poolConfigContract, "PoolNameChanged")
                    .withArgs(poolName, protocolOwner.address);
                expect(await poolConfigContract.poolName()).to.equal(poolName);
            });

            it("Should reject non-owner or admin to call setPoolName", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setPoolName(poolName),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setPoolOwnerTreasury", function () {
            it("Should allow the pool owner to call setPoolOwnerTreasury", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolOwnerTreasury(poolOwnerTreasury.address),
                )
                    .to.emit(poolConfigContract, "PoolOwnerTreasuryChanged")
                    .withArgs(poolOwnerTreasury.address, poolOwner.address);
                expect(await poolConfigContract.poolOwnerTreasury()).to.equal(
                    poolOwnerTreasury.address,
                );
            });

            it("Should allow the Huma master admin to call setPoolOwnerTreasury", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolOwnerTreasury(poolOwnerTreasury.address),
                )
                    .to.emit(poolConfigContract, "PoolOwnerTreasuryChanged")
                    .withArgs(poolOwnerTreasury.address, protocolOwner.address);
                expect(await poolConfigContract.poolOwnerTreasury()).to.equal(
                    poolOwnerTreasury.address,
                );
            });

            it("Should reject non-owner or admin to call setPoolOwnerTreasury", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolOwnerTreasury(poolOwnerTreasury.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for pool owner treasury", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolOwnerTreasury(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setPoolUnderlyingToken", function () {
            it("Should allow the pool owner to set the underlying token", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolUnderlyingToken(mockTokenContract.address),
                )
                    .to.emit(poolConfigContract, "PoolUnderlyingTokenChanged")
                    .withArgs(mockTokenContract.address, poolOwner.address);
                expect(await poolConfigContract.underlyingToken()).to.equal(
                    mockTokenContract.address,
                );
            });

            it("Should allow the Huma master admin to set the underlying token", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolUnderlyingToken(mockTokenContract.address),
                )
                    .to.emit(poolConfigContract, "PoolUnderlyingTokenChanged")
                    .withArgs(mockTokenContract.address, protocolOwner.address);
                expect(await poolConfigContract.underlyingToken()).to.equal(
                    mockTokenContract.address,
                );
            });

            it("Should reject non-owner or admin to set the underlying token", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setPoolUnderlyingToken(poolOwnerTreasury.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the underlying token", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolUnderlyingToken(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setTranches", function () {
            it("Should allow the pool owner to set the tranches", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranches(
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                        ),
                )
                    .to.emit(poolConfigContract, "TranchesChanged")
                    .withArgs(
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        poolOwner.address,
                    );
                expect(await poolConfigContract.seniorTranche()).to.equal(
                    seniorTrancheVaultContract.address,
                );
                expect(await poolConfigContract.juniorTranche()).to.equal(
                    juniorTrancheVaultContract.address,
                );
            });

            it("Should allow the Huma master admin to set the tranches", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setTranches(
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                        ),
                )
                    .to.emit(poolConfigContract, "TranchesChanged")
                    .withArgs(
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        protocolOwner.address,
                    );
                expect(await poolConfigContract.seniorTranche()).to.equal(
                    seniorTrancheVaultContract.address,
                );
                expect(await poolConfigContract.juniorTranche()).to.equal(
                    juniorTrancheVaultContract.address,
                );
            });

            it("Should reject non-owner or admin to set the tranches", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setTranches(
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero addresses for the senior tranche", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranches(
                            ethers.constants.AddressZero,
                            juniorTrancheVaultContract.address,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });

            it("Should disallow zero addresses for the junior tranche", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranches(
                            seniorTrancheVaultContract.address,
                            ethers.constants.AddressZero,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setPoolSafe", function () {
            it("Should allow the pool owner to set the pool safe", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setPoolSafe(poolSafeContract.address),
                )
                    .to.emit(poolConfigContract, "PoolSafeChanged")
                    .withArgs(poolSafeContract.address, poolOwner.address);
                expect(await poolConfigContract.poolSafe()).to.equal(poolSafeContract.address);
            });

            it("Should allow the Huma master admin to set the pool safe", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setPoolSafe(poolSafeContract.address),
                )
                    .to.emit(poolConfigContract, "PoolSafeChanged")
                    .withArgs(poolSafeContract.address, protocolOwner.address);
                expect(await poolConfigContract.poolSafe()).to.equal(poolSafeContract.address);
            });

            it("Should reject non-owner or admin to set the pool safe", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setPoolSafe(poolSafeContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the pool safe", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setPoolSafe(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setTranchesPolicy", function () {
            it("Should allow the pool owner to set the tranches policy", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranchesPolicy(tranchesPolicyContract.address),
                )
                    .to.emit(poolConfigContract, "TranchesPolicyChanged")
                    .withArgs(tranchesPolicyContract.address, poolOwner.address);
                expect(await poolConfigContract.tranchesPolicy()).to.equal(
                    tranchesPolicyContract.address,
                );
            });

            it("Should allow the Huma master admin to set the tranches policy", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setTranchesPolicy(tranchesPolicyContract.address),
                )
                    .to.emit(poolConfigContract, "TranchesPolicyChanged")
                    .withArgs(tranchesPolicyContract.address, protocolOwner.address);
                expect(await poolConfigContract.tranchesPolicy()).to.equal(
                    tranchesPolicyContract.address,
                );
            });

            it("Should reject non-owner or admin to set the tranches policy", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setTranchesPolicy(tranchesPolicyContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the tranches policy", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setTranchesPolicy(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setEpochManager", function () {
            it("Should allow the pool owner to set the epoch manager", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEpochManager(epochManagerContract.address),
                )
                    .to.emit(poolConfigContract, "EpochManagerChanged")
                    .withArgs(epochManagerContract.address, poolOwner.address);
                expect(await poolConfigContract.epochManager()).to.equal(
                    epochManagerContract.address,
                );
            });

            it("Should allow the Huma master admin to set the epoch manager", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setEpochManager(epochManagerContract.address),
                )
                    .to.emit(poolConfigContract, "EpochManagerChanged")
                    .withArgs(epochManagerContract.address, protocolOwner.address);
                expect(await poolConfigContract.epochManager()).to.equal(
                    epochManagerContract.address,
                );
            });

            it("Should reject non-owner or admin to set the epoch manager", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setEpochManager(epochManagerContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the epoch manager", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setEpochManager(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setCredit", function () {
            it("Should allow the pool owner to set the credit contract", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setCredit(creditContract.address),
                )
                    .to.emit(poolConfigContract, "CreditChanged")
                    .withArgs(creditContract.address, poolOwner.address);
                expect(await poolConfigContract.credit()).to.equal(creditContract.address);
            });

            it("Should allow the Huma master admin to set the credit contract", async function () {
                await expect(
                    poolConfigContract.connect(protocolOwner).setCredit(creditContract.address),
                )
                    .to.emit(poolConfigContract, "CreditChanged")
                    .withArgs(creditContract.address, protocolOwner.address);
                expect(await poolConfigContract.credit()).to.equal(creditContract.address);
            });

            it("Should reject non-owner or admin to set the credit contract", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setCredit(creditContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the credit contract", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setCredit(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setFirstLossCover", function () {
            let config: FirstLossCoverConfigStruct;

            before(function () {
                config = {
                    coverRatePerLossInBps: 1_000,
                    coverCapPerLoss: toToken(1_000_000),
                    maxLiquidity: toToken(2_000_000),
                    minLiquidity: 0,
                    riskYieldMultiplierInBps: 20000,
                };
            });

            async function testSetterAndGetter(actor: SignerWithAddress) {
                await expect(
                    poolConfigContract
                        .connect(actor)
                        .setFirstLossCover(
                            CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                            affiliateFirstLossCoverContract.address,
                            config,
                        ),
                )
                    .to.emit(poolConfigContract, "FirstLossCoverChanged")
                    .withArgs(
                        CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                        affiliateFirstLossCoverContract.address,
                        config.coverRatePerLossInBps,
                        config.coverCapPerLoss,
                        config.maxLiquidity,
                        config.minLiquidity,
                        config.riskYieldMultiplierInBps,
                        await actor.getAddress(),
                    );

                const coverConfig = await poolConfigContract.getFirstLossCoverConfig(
                    affiliateFirstLossCoverContract.address,
                );
                expect(coverConfig.coverRatePerLossInBps).to.equal(config.coverRatePerLossInBps);
                expect(coverConfig.coverCapPerLoss).to.equal(config.coverCapPerLoss);
                expect(coverConfig.maxLiquidity).to.equal(config.maxLiquidity);
                expect(coverConfig.minLiquidity).to.equal(config.minLiquidity);
                expect(coverConfig.riskYieldMultiplierInBps).to.equal(
                    config.riskYieldMultiplierInBps,
                );
            }

            it("Should allow the pool owner to set the first loss cover", async function () {
                await testSetterAndGetter(poolOwner);
            });

            it("Should allow the Huma master admin to set the first loss cover", async function () {
                await testSetterAndGetter(protocolOwner);
            });

            it("Should not allow others to set the first loss cover", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setFirstLossCover(
                            CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                            affiliateFirstLossCoverContract.address,
                            config,
                        ),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setCalendar", function () {
            it("Should allow the pool owner to set the calendar contract", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setCalendar(calendarContract.address),
                )
                    .to.emit(poolConfigContract, "CalendarChanged")
                    .withArgs(calendarContract.address, poolOwner.address);
                expect(await poolConfigContract.calendar()).to.equal(calendarContract.address);
            });

            it("Should allow the Huma master admin to set the calendar contract", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setCalendar(calendarContract.address),
                )
                    .to.emit(poolConfigContract, "CalendarChanged")
                    .withArgs(calendarContract.address, protocolOwner.address);
                expect(await poolConfigContract.calendar()).to.equal(calendarContract.address);
            });

            it("Should reject non-owner or admin to set the calendar contract", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setCalendar(calendarContract.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the calendar contract", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setCalendar(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setReceivableAsset", function () {
            it("Should allow the pool owner to set the receivable asset", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setReceivableAsset(defaultDeployer.address),
                )
                    .to.emit(poolConfigContract, "ReceivableAssetChanged")
                    .withArgs(defaultDeployer.address, poolOwner.address);
                expect(await poolConfigContract.receivableAsset()).to.equal(
                    defaultDeployer.address,
                );
            });

            it("Should allow the Huma master admin to set the receivable asset", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setReceivableAsset(defaultDeployer.address),
                )
                    .to.emit(poolConfigContract, "ReceivableAssetChanged")
                    .withArgs(defaultDeployer.address, protocolOwner.address);
                expect(await poolConfigContract.receivableAsset()).to.equal(
                    defaultDeployer.address,
                );
            });

            it("Should reject non-owner or admin to set the receivable asset", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setReceivableAsset(defaultDeployer.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow zero address for the receivable asset", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setReceivableAsset(ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
            });
        });

        describe("setPoolSettings", function () {
            let newSettings: PoolSettingsStructOutput;

            beforeEach(async function () {
                const oldSettings = await poolConfigContract.getPoolSettings();
                newSettings = {
                    ...oldSettings,
                    ...{
                        payPeriodDuration: PayPeriodDuration.Quarterly,
                    },
                };
            });

            it("Should allow the pool owner to set the pool settings", async function () {
                await expect(poolConfigContract.connect(poolOwner).setPoolSettings(newSettings))
                    .to.emit(poolConfigContract, "PoolSettingsChanged")
                    .withArgs(
                        newSettings.maxCreditLine,
                        newSettings.minDepositAmount,
                        newSettings.payPeriodDuration,
                        newSettings.latePaymentGracePeriodInDays,
                        newSettings.defaultGracePeriodInDays,
                        newSettings.advanceRateInBps,
                        newSettings.receivableAutoApproval,
                        await poolOwner.getAddress(),
                    );

                const actualNewSettings = await poolConfigContract.getPoolSettings();
                expect(actualNewSettings.maxCreditLine).to.equal(newSettings.maxCreditLine);
                expect(actualNewSettings.minDepositAmount).to.equal(newSettings.minDepositAmount);
                expect(actualNewSettings.payPeriodDuration).to.equal(
                    newSettings.payPeriodDuration,
                );
                expect(actualNewSettings.latePaymentGracePeriodInDays).to.equal(
                    newSettings.latePaymentGracePeriodInDays,
                );
                expect(actualNewSettings.defaultGracePeriodInDays).to.equal(
                    newSettings.defaultGracePeriodInDays,
                );
                expect(actualNewSettings.advanceRateInBps).to.equal(newSettings.advanceRateInBps);
                expect(actualNewSettings.receivableAutoApproval).to.equal(
                    newSettings.receivableAutoApproval,
                );
            });

            it("Should allow the Huma master admin to set the pool settings", async function () {
                await expect(
                    poolConfigContract.connect(protocolOwner).setPoolSettings(newSettings),
                )
                    .to.emit(poolConfigContract, "PoolSettingsChanged")
                    .withArgs(
                        newSettings.maxCreditLine,
                        newSettings.minDepositAmount,
                        newSettings.payPeriodDuration,
                        newSettings.latePaymentGracePeriodInDays,
                        newSettings.defaultGracePeriodInDays,
                        newSettings.advanceRateInBps,
                        newSettings.receivableAutoApproval,
                        await protocolOwner.getAddress(),
                    );

                const actualNewSettings = await poolConfigContract.getPoolSettings();
                expect(actualNewSettings.maxCreditLine).to.equal(newSettings.maxCreditLine);
                expect(actualNewSettings.minDepositAmount).to.equal(newSettings.minDepositAmount);
                expect(actualNewSettings.payPeriodDuration).to.equal(
                    newSettings.payPeriodDuration,
                );
                expect(actualNewSettings.latePaymentGracePeriodInDays).to.equal(
                    newSettings.latePaymentGracePeriodInDays,
                );
                expect(actualNewSettings.defaultGracePeriodInDays).to.equal(
                    newSettings.defaultGracePeriodInDays,
                );
                expect(actualNewSettings.advanceRateInBps).to.equal(newSettings.advanceRateInBps);
                expect(actualNewSettings.receivableAutoApproval).to.equal(
                    newSettings.receivableAutoApproval,
                );
            });

            it("Should reject non-owner or admin to set the pool settings", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setPoolSettings(newSettings),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });

            it("Should disallow min deposit amount that's less than the min threshold", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setPoolSettings({
                        ...newSettings,
                        ...{
                            minDepositAmount: 10 ** 6 - 1,
                        },
                    }),
                ).to.be.revertedWithCustomError(poolConfigContract, "minDepositAmountTooLow");
            });

            it("Should disallow advance rates that exceed 10000", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setPoolSettings({
                        ...newSettings,
                        ...{
                            advanceRateInBps: 10001,
                        },
                    }),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "invalidBasisPointHigherThan10000",
                );
            });
        });

        describe("setLPConfig", function () {
            let newLPConfig: LPConfigStruct;

            before(async function () {
                newLPConfig = {
                    permissioned: false,
                    liquidityCap: toToken(100_000_000),
                    maxSeniorJuniorRatio: 4,
                    fixedSeniorYieldInBps: 2000,
                    tranchesRiskAdjustmentInBps: 8000,
                    withdrawalLockoutPeriodInDays: 30,
                };
            });

            it("Should allow the pool owner to set the LP config", async function () {
                await expect(poolConfigContract.connect(poolOwner).setLPConfig(newLPConfig))
                    .to.emit(poolConfigContract, "LPConfigChanged")
                    .withArgs(
                        newLPConfig.permissioned,
                        newLPConfig.liquidityCap,
                        newLPConfig.maxSeniorJuniorRatio,
                        newLPConfig.fixedSeniorYieldInBps,
                        newLPConfig.tranchesRiskAdjustmentInBps,
                        newLPConfig.withdrawalLockoutPeriodInDays,
                        poolOwner.address,
                    );
                const lpConfig = await poolConfigContract.getLPConfig();
                expect(lpConfig.permissioned).to.equal(newLPConfig.permissioned);
                expect(lpConfig.liquidityCap).to.equal(newLPConfig.liquidityCap);
                expect(lpConfig.withdrawalLockoutPeriodInDays).to.equal(
                    newLPConfig.withdrawalLockoutPeriodInDays,
                );
                expect(lpConfig.maxSeniorJuniorRatio).to.equal(newLPConfig.maxSeniorJuniorRatio);
                expect(lpConfig.fixedSeniorYieldInBps).to.equal(newLPConfig.fixedSeniorYieldInBps);
                expect(lpConfig.tranchesRiskAdjustmentInBps).to.equal(
                    newLPConfig.tranchesRiskAdjustmentInBps,
                );
            });

            it("Should allow the Huma master admin to set the LP config", async function () {
                await expect(poolConfigContract.connect(protocolOwner).setLPConfig(newLPConfig))
                    .to.emit(poolConfigContract, "LPConfigChanged")
                    .withArgs(
                        newLPConfig.permissioned,
                        newLPConfig.liquidityCap,
                        newLPConfig.maxSeniorJuniorRatio,
                        newLPConfig.fixedSeniorYieldInBps,
                        newLPConfig.tranchesRiskAdjustmentInBps,
                        newLPConfig.withdrawalLockoutPeriodInDays,
                        protocolOwner.address,
                    );
                const lpConfig = await poolConfigContract.getLPConfig();
                expect(lpConfig.permissioned).to.equal(newLPConfig.permissioned);
                expect(lpConfig.liquidityCap).to.equal(newLPConfig.liquidityCap);
                expect(lpConfig.withdrawalLockoutPeriodInDays).to.equal(
                    newLPConfig.withdrawalLockoutPeriodInDays,
                );
                expect(lpConfig.maxSeniorJuniorRatio).to.equal(newLPConfig.maxSeniorJuniorRatio);
                expect(lpConfig.fixedSeniorYieldInBps).to.equal(newLPConfig.fixedSeniorYieldInBps);
                expect(lpConfig.tranchesRiskAdjustmentInBps).to.equal(
                    newLPConfig.tranchesRiskAdjustmentInBps,
                );
            });

            it("Should reject non-owner or admin to set the LP config", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setLPConfig(newLPConfig),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setFrontLoadingFees", function () {
            let newFrontLoadingFeeStructure: FrontLoadingFeesStructureStruct;

            before(async function () {
                newFrontLoadingFeeStructure = {
                    frontLoadingFeeFlat: toToken(50),
                    frontLoadingFeeBps: BN.from(100),
                };
            });

            it("Should allow the pool owner to set the front loading fees", async function () {
                await expect(
                    poolConfigContract
                        .connect(poolOwner)
                        .setFrontLoadingFees(newFrontLoadingFeeStructure),
                )
                    .to.emit(poolConfigContract, "FrontLoadingFeesChanged")
                    .withArgs(
                        newFrontLoadingFeeStructure.frontLoadingFeeFlat,
                        newFrontLoadingFeeStructure.frontLoadingFeeBps,
                        poolOwner.address,
                    );
                const frontLoadingFees = await poolConfigContract.getFrontLoadingFees();
                expect(frontLoadingFees[0]).to.equal(
                    newFrontLoadingFeeStructure.frontLoadingFeeFlat,
                );
                expect(frontLoadingFees[1]).to.equal(
                    newFrontLoadingFeeStructure.frontLoadingFeeBps,
                );
            });

            it("Should allow the Huma master admin to set the front loading fees", async function () {
                await expect(
                    poolConfigContract
                        .connect(protocolOwner)
                        .setFrontLoadingFees(newFrontLoadingFeeStructure),
                )
                    .to.emit(poolConfigContract, "FrontLoadingFeesChanged")
                    .withArgs(
                        newFrontLoadingFeeStructure.frontLoadingFeeFlat,
                        newFrontLoadingFeeStructure.frontLoadingFeeBps,
                        protocolOwner.address,
                    );
                const frontLoadingFees = await poolConfigContract.getFrontLoadingFees();
                expect(frontLoadingFees[0]).to.equal(
                    newFrontLoadingFeeStructure.frontLoadingFeeFlat,
                );
                expect(frontLoadingFees[1]).to.equal(
                    newFrontLoadingFeeStructure.frontLoadingFeeBps,
                );
            });

            it("Should reject non-owner or admin to set the front loading fees", async function () {
                await expect(
                    poolConfigContract
                        .connect(regularUser)
                        .setFrontLoadingFees(newFrontLoadingFeeStructure),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("setFeeStructure", function () {
            let newFeeStructure: FeeStructureStruct;

            before(async function () {
                newFeeStructure = {
                    yieldInBps: BN.from(1000),
                    minPrincipalRateInBps: BN.from(2000),
                    lateFeeBps: BN.from(3000),
                };
            });

            it("Should allow the pool owner to set the fee structure", async function () {
                await expect(
                    poolConfigContract.connect(poolOwner).setFeeStructure(newFeeStructure),
                )
                    .to.emit(poolConfigContract, "FeeStructureChanged")
                    .withArgs(
                        newFeeStructure.yieldInBps,
                        newFeeStructure.minPrincipalRateInBps,
                        newFeeStructure.lateFeeBps,
                        poolOwner.address,
                    );
                let fees = await poolConfigContract.getFeeStructure();
                expect(fees.yieldInBps).to.equal(newFeeStructure.yieldInBps);
                expect(fees.lateFeeBps).to.equal(newFeeStructure.lateFeeBps);
                expect(fees.minPrincipalRateInBps).to.equal(newFeeStructure.minPrincipalRateInBps);
            });

            it("Should allow the Huma master admin to set the fee structure", async function () {
                await expect(
                    poolConfigContract.connect(protocolOwner).setFeeStructure(newFeeStructure),
                )
                    .to.emit(poolConfigContract, "FeeStructureChanged")
                    .withArgs(
                        newFeeStructure.yieldInBps,
                        newFeeStructure.minPrincipalRateInBps,
                        newFeeStructure.lateFeeBps,
                        protocolOwner.address,
                    );

                let fees = await poolConfigContract.getFeeStructure();
                expect(fees.yieldInBps).to.equal(newFeeStructure.yieldInBps);
                expect(fees.lateFeeBps).to.equal(newFeeStructure.lateFeeBps);
                expect(fees.minPrincipalRateInBps).to.equal(newFeeStructure.minPrincipalRateInBps);
            });

            it("Should reject non-owner or admin to set the fee structure", async function () {
                await expect(
                    poolConfigContract.connect(regularUser).setFeeStructure(newFeeStructure),
                ).to.be.revertedWithCustomError(poolConfigContract, "permissionDeniedNotAdmin");
            });
        });

        describe("checkLiquidityRequirementForPoolOwner", function () {
            let minRequirement: BN;

            beforeEach(async function () {
                minRequirement = await getMinLiquidityRequirementForPoolOwner(poolConfigContract);
            });

            it("Should pass the checks when there is enough liquidity", async function () {
                await poolConfigContract.checkLiquidityRequirementForPoolOwner(minRequirement);
            });

            it("Should revert when the pool owner has not provided enough liquidity", async function () {
                await expect(
                    poolConfigContract.checkLiquidityRequirementForPoolOwner(
                        minRequirement.sub(1),
                    ),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolOwnerNotEnoughLiquidity");
            });
        });

        describe("checkLiquidityRequirementForEA", function () {
            let minRequirement: BN;

            beforeEach(async function () {
                minRequirement = await getMinLiquidityRequirementForEA(poolConfigContract);
            });

            it("Should pass the checks when there is enough liquidity", async function () {
                await poolConfigContract.checkLiquidityRequirementForEA(minRequirement);
            });

            it("Should revert when the pool owner has not provided enough liquidity", async function () {
                await expect(
                    poolConfigContract.checkLiquidityRequirementForEA(minRequirement.sub(1)),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "evaluationAgentNotEnoughLiquidity",
                );
            });
        });

        describe("checkLiquidityRequirementForRedemption", function () {
            let poolOwnerMinRequirement: BN, eaMinRequirement: BN;

            beforeEach(async function () {
                poolOwnerMinRequirement =
                    await getMinLiquidityRequirementForPoolOwner(poolConfigContract);
                eaMinRequirement = await getMinLiquidityRequirementForEA(poolConfigContract);
            });

            it("Should pass the check for non-admins even if they have not deposited liquidity", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    regularUser.address,
                    juniorTrancheVaultContract.address,
                    0,
                );
            });

            it("Should pass the check when the pool owner still has enough liquidity after redemption in the junior tranche", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    poolOwner.address,
                    juniorTrancheVaultContract.address,
                    poolOwnerMinRequirement,
                );
            });

            it("Should pass the check when the evaluation agent still has enough liquidity after redemption in the junior tranche", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    evaluationAgent.address,
                    juniorTrancheVaultContract.address,
                    eaMinRequirement,
                );
            });

            it("Should pass the check even if the pool owner does not have any liquidity left in the senior tranche", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    poolOwner.address,
                    seniorTrancheVaultContract.address,
                    0,
                );
            });

            it("Should pass the check even if the EA does not have any liquidity left in the senior tranche", async function () {
                await poolConfigContract.checkLiquidityRequirementForRedemption(
                    evaluationAgent.address,
                    seniorTrancheVaultContract.address,
                    0,
                );
            });

            it("Should revert when the pool owner no longer has enough liquidity after redemption in the junior tranche", async function () {
                await expect(
                    poolConfigContract.checkLiquidityRequirementForRedemption(
                        poolOwnerTreasury.address,
                        juniorTrancheVaultContract.address,
                        poolOwnerMinRequirement.sub(1),
                    ),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolOwnerNotEnoughLiquidity");
            });

            it("Should revert when EA no longer has enough liquidity after redemption in the junior tranche", async function () {
                // Set an EA for the first time.
                let eaNFTTokenId;
                const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
                const receipt = await tx.wait();
                for (const evt of receipt.events!) {
                    if (evt.event === "NFTGenerated") {
                        eaNFTTokenId = evt.args!.tokenId;
                    }
                }
                const adminRnR = await poolConfigContract.getAdminRnR();
                const lpConfig = await poolConfigContract.getLPConfig();
                const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByEA)
                    .mul(lpConfig.liquidityCap)
                    .div(CONSTANTS.BP_FACTOR);
                await juniorTrancheVaultContract
                    .connect(poolOwner)
                    .addApprovedLender(evaluationAgent.getAddress(), true);
                await juniorTrancheVaultContract
                    .connect(evaluationAgent)
                    .deposit(evaluationAgentLiquidity, evaluationAgent.getAddress());
                await poolConfigContract
                    .connect(poolOwner)
                    .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);

                await expect(
                    poolConfigContract.checkLiquidityRequirementForRedemption(
                        evaluationAgent.address,
                        juniorTrancheVaultContract.address,
                        eaMinRequirement.sub(1),
                    ),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "evaluationAgentNotEnoughLiquidity",
                );
            });
        });

        describe("First loss cover getters", function () {
            it("Should return the correct first loss cover(s)", async function () {
                const firstLossCovers = await poolConfigContract.getFirstLossCovers();
                for (const index of [
                    CONSTANTS.BORROWER_FIRST_LOSS_COVER_INDEX,
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                ]) {
                    const firstLossCover = await poolConfigContract.getFirstLossCover(index);
                    expect(firstLossCover).to.equal(firstLossCovers[index]);
                }
            });
        });
    });
});