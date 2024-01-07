import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { EvaluationAgentNFT, HumaConfig, MockToken } from "../../../typechain-types";

describe("HumaConfig Tests", function () {
    let eaNFTContract: EvaluationAgentNFT,
        configContract: HumaConfig,
        mockTokenContract: MockToken;
    let origOwner: SignerWithAddress,
        pauser: SignerWithAddress,
        poolAdmin: SignerWithAddress,
        treasury: SignerWithAddress,
        newOwner: SignerWithAddress,
        newTreasury: SignerWithAddress,
        sentinelServiceAccount: SignerWithAddress,
        eaServiceAccount: SignerWithAddress,
        randomUser: SignerWithAddress;

    before(async function () {
        [
            origOwner,
            pauser,
            poolAdmin,
            treasury,
            newOwner,
            newTreasury,
            sentinelServiceAccount,
            eaServiceAccount,
            randomUser,
        ] = await ethers.getSigners();

        // Deploy EvaluationAgentNFT
        const EvaluationAgentNFT = await ethers.getContractFactory("EvaluationAgentNFT");
        eaNFTContract = await EvaluationAgentNFT.deploy();

        const HumaConfig = await ethers.getContractFactory("HumaConfig");
        configContract = await HumaConfig.deploy();

        // Deploy MockToken, give initial tokens to lender
        const MockToken = await ethers.getContractFactory("MockToken");
        mockTokenContract = await MockToken.deploy();
    });

    describe("Initial Value", function () {
        it("Should have the right initial owner", async function () {
            expect(await configContract.owner()).to.equal(origOwner.address);
        });

        it("Should have the right treasury fee", async function () {
            expect(await configContract.protocolFeeInBps()).to.equal(500);
        });
    });

    describe("Update owner", function () {
        it("Should disallow non-owner to change ownership", async function () {
            await expect(
                configContract.connect(newOwner).transferOwnership(newOwner.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject 0 address to be the new owner", async function () {
            await expect(
                configContract.connect(origOwner).transferOwnership(ethers.constants.AddressZero),
            ).to.be.revertedWith("Ownable: new owner is the zero address");
        });

        it("Should be able to transfer ownership to new owner", async function () {
            await configContract.connect(origOwner).transferOwnership(newOwner.address);
            expect(await configContract.owner()).to.equal(newOwner.address);

            // change back to orgOwner to continue the testing flow.
            await configContract.connect(newOwner).transferOwnership(origOwner.address);
            expect(await configContract.owner()).to.equal(origOwner.address);
        });
    });

    describe("Update Huma Treasury Address", function () {
        it("Should disallow non-owner to change huma treasury", async function () {
            await expect(
                configContract.connect(randomUser).setHumaTreasury(treasury.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should disallow previous protocol owner to change huma treasury", async function () {
            await expect(
                configContract.connect(origOwner).setHumaTreasury(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(configContract, "ZeroAddressProvided");
        });

        it("Should allow treasury to be changed", async function () {
            expect(await configContract.connect(origOwner).setHumaTreasury(newTreasury.address))
                .to.emit(configContract, "HumaTreasuryChanged")
                .withArgs(newTreasury.address);
            expect(await configContract.connect(origOwner).humaTreasury()).to.equal(
                newTreasury.address,
            );
        });

        it("Should not emit event if try to set treasury to the existing treasury address", async function () {
            expect(await configContract.connect(origOwner).humaTreasury()).to.equal(
                newTreasury.address,
            );
            expect(
                await configContract.connect(origOwner).setHumaTreasury(newTreasury.address),
            ).to.not.emit(configContract, "HumaTreasuryChanged");
            expect(await configContract.connect(origOwner).humaTreasury()).to.equal(
                newTreasury.address,
            );
        });
    });

    describe("Add and Remove Pausers", function () {
        it("Should disallow non-owner to add pausers", async function () {
            await expect(
                configContract.connect(randomUser).addPauser(pauser.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject 0 address pauser", async function () {
            await expect(
                configContract.connect(origOwner).addPauser(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(configContract, "ZeroAddressProvided");
        });

        it("Should allow pauser to be added", async function () {
            expect(await configContract.connect(origOwner).addPauser(pauser.address))
                .to.emit(configContract, "PauserAdded")
                .withArgs(pauser.address, origOwner.address);

            expect(await configContract.connect(origOwner).isPauser(pauser.address)).to.equal(
                true,
            );
        });

        it("Should reject add-pauser request if it is already a pauser", async function () {
            await expect(
                configContract.connect(origOwner).addPauser(pauser.address),
            ).to.be.revertedWithCustomError(configContract, "AlreadyAPauser");
        });

        it("Should disallow non-owner to remove a pauser", async function () {
            await expect(
                configContract.connect(randomUser).removePauser(pauser.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");

            expect(await configContract.isPauser(pauser.address)).to.equal(true);

            await expect(
                configContract.connect(pauser).removePauser(pauser.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");

            expect(await configContract.isPauser(pauser.address)).to.equal(true);
        });

        it("Should disallow removal of pauser using zero address", async function () {
            await expect(
                configContract.connect(origOwner).removePauser(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(configContract, "ZeroAddressProvided");
        });

        it("Should reject attemp to removal a pauser who is not a pauser", async function () {
            await expect(
                configContract.connect(origOwner).removePauser(treasury.address),
            ).to.be.revertedWithCustomError(configContract, "PauserRequired");
        });

        it("Should remove a pauser successfully", async function () {
            await expect(configContract.connect(origOwner).removePauser(pauser.address))
                .to.emit(configContract, "PauserRemoved")
                .withArgs(pauser.address, origOwner.address);

            expect(await configContract.connect(origOwner).isPauser(pauser.address)).to.equal(
                false,
            );
        });

        it("Should allow removed pauser to be added back", async function () {
            expect(await configContract.connect(origOwner).addPauser(pauser.address))
                .to.emit(configContract, "PauserAdded")
                .withArgs(pauser.address, origOwner.address);

            expect(await configContract.connect(origOwner).isPauser(pauser.address)).to.equal(
                true,
            );
        });
    });

    describe("Pause and Unpause Protocol", function () {
        it("Should disallow non-pauser to pause the protocol", async function () {
            await expect(configContract.connect(randomUser).pause()).to.be.revertedWithCustomError(
                configContract,
                "PauserRequired",
            );
            await expect(configContract.connect(treasury).pause()).to.be.revertedWithCustomError(
                configContract,
                "PauserRequired",
            );
        });

        it("Should be able to pause the protocol", async function () {
            await expect(configContract.connect(pauser).pause())
                .to.emit(configContract, "Paused")
                .withArgs(pauser.address);
            expect(await configContract.paused()).to.equal(true);
        });

        it("Should disallow non-owner to unpause", async function () {
            await expect(configContract.connect(pauser).unpause()).to.be.revertedWith(
                "Ownable: caller is not the owner",
            );
        });

        it("Should allow owner to unpause", async function () {
            expect(await configContract.connect(origOwner).unpause())
                .to.emit(configContract, "Unpaused")
                .withArgs(origOwner.address);

            expect(await configContract.paused()).to.equal(false);
        });
    });

    describe("Add and Remove Pool Admins", function () {
        it("Should disallow non-owner to add pool admins", async function () {
            await expect(
                configContract.connect(randomUser).addPoolAdmin(poolAdmin.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject 0 address pool admin", async function () {
            await expect(
                configContract.connect(origOwner).addPoolAdmin(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(configContract, "ZeroAddressProvided");
        });

        it("Should allow pool admin to be added", async function () {
            expect(await configContract.connect(origOwner).addPoolAdmin(poolAdmin.address))
                .to.emit(configContract, "PoolAdminAdded")
                .withArgs(poolAdmin.address, origOwner.address);

            expect(
                await configContract.connect(origOwner).isPoolAdmin(poolAdmin.address),
            ).to.equal(true);
        });

        it("Should reject add-pool-admin request if it is already a pool admin", async function () {
            await expect(
                configContract.connect(origOwner).addPoolAdmin(poolAdmin.address),
            ).to.be.revertedWithCustomError(configContract, "AlreadyPoolAdmin");
        });

        it("Should disallow non-owner to remove a pool admin", async function () {
            await expect(
                configContract.connect(randomUser).removePoolAdmin(poolAdmin.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");

            await expect(
                configContract.connect(poolAdmin).removePoolAdmin(poolAdmin.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should disallow removal of pool admin using zero address", async function () {
            await expect(
                configContract.connect(origOwner).removePoolAdmin(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(configContract, "ZeroAddressProvided");
        });

        it("Should reject attempt to remove a pool admin who is not a pool admin", async function () {
            await expect(
                configContract.connect(origOwner).removePoolAdmin(treasury.address),
            ).to.be.revertedWithCustomError(configContract, "PoolOwnerRequired");
        });

        it("Should remove a pool admin successfully", async function () {
            await expect(configContract.connect(origOwner).removePoolAdmin(poolAdmin.address))
                .to.emit(configContract, "PoolAdminRemoved")
                .withArgs(poolAdmin.address, origOwner.address);

            expect(
                await configContract.connect(origOwner).isPoolAdmin(poolAdmin.address),
            ).to.equal(false);
        });

        it("Should allow removed pool admin to be added back", async function () {
            expect(await configContract.connect(origOwner).addPoolAdmin(poolAdmin.address))
                .to.emit(configContract, "PoolAdminAdded")
                .withArgs(poolAdmin.address, origOwner.address);

            expect(
                await configContract.connect(origOwner).isPoolAdmin(poolAdmin.address),
            ).to.equal(true);
        });
    });

    // Test suites for changing treasury fee
    describe("Change Treasury Fee", function () {
        it("Should disallow non-owner to change treasury fee", async function () {
            await expect(
                configContract.connect(randomUser).setTreasuryFee(200),
            ).to.be.revertedWith("Ownable: caller is not the owner");
            await expect(configContract.connect(treasury).setTreasuryFee(200)).to.be.revertedWith(
                "Ownable: caller is not the owner",
            );
        });

        it("Should disallow treasury fee to be higher than 5000 bps, i.e. 50%", async function () {
            await expect(
                configContract.connect(origOwner).setTreasuryFee(6000),
            ).to.be.revertedWithCustomError(configContract, "TreasuryFeeHighThanUpperLimit");
        });

        it("Should be able to change treasury fee", async function () {
            await expect(configContract.connect(origOwner).setTreasuryFee(2000))
                .to.emit(configContract, "TreasuryFeeChanged")
                .withArgs(500, 2000);
            expect(await configContract.protocolFeeInBps()).to.equal(2000);
        });
    });

    // Test suite for sentinelServiceAccount
    describe("Update sentinelServiceAccount", function () {
        it("Should disallow non-owner to change sentinelServiceAccount", async function () {
            await expect(
                configContract
                    .connect(randomUser)
                    .setSentinelServiceAccount(sentinelServiceAccount.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject 0 address sentinelServiceAccount", async function () {
            await expect(
                configContract
                    .connect(origOwner)
                    .setSentinelServiceAccount(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(configContract, "ZeroAddressProvided");
        });

        it("Should allow sentinelServiceAccount to be changed", async function () {
            expect(
                await configContract
                    .connect(origOwner)
                    .setSentinelServiceAccount(sentinelServiceAccount.address),
            )
                .to.emit(configContract, "SentinelServiceAccountChanged")
                .withArgs(sentinelServiceAccount.address);
            expect(await configContract.connect(origOwner).sentinelServiceAccount()).to.equal(
                sentinelServiceAccount.address,
            );
        });
    });

    // Test suite for eaServiceAccount
    describe("Update eaServiceAccount", function () {
        it("Should disallow non-owner to change eaServiceAccount", async function () {
            await expect(
                configContract.connect(randomUser).setEAServiceAccount(eaServiceAccount.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject 0 address eaServiceAccount", async function () {
            await expect(
                configContract
                    .connect(origOwner)
                    .setEAServiceAccount(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(configContract, "ZeroAddressProvided");
        });

        it("Should allow eaServiceAccount to be changed", async function () {
            expect(
                await configContract
                    .connect(origOwner)
                    .setEAServiceAccount(eaServiceAccount.address),
            )
                .to.emit(configContract, "EAServiceAccountChanged")
                .withArgs(eaServiceAccount.address);
            expect(await configContract.connect(origOwner).eaServiceAccount()).to.equal(
                eaServiceAccount.address,
            );
        });
    });

    // Test suites for valid liquidity assets
    describe("Change Liquidity Assets", function () {
        it("Should disallow non-proto-admin to change liquidity asset", async function () {
            await expect(
                configContract
                    .connect(randomUser)
                    .setLiquidityAsset(mockTokenContract.address, true),
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should be able to add valid liquidity assets", async function () {
            await expect(
                configContract
                    .connect(origOwner)
                    .setLiquidityAsset(mockTokenContract.address, true),
            )
                .to.emit(configContract, "LiquidityAssetAdded")
                .withArgs(mockTokenContract.address, origOwner.address);
            expect(await configContract.isAssetValid(mockTokenContract.address)).to.equal(true);
        });

        it("Should be able to remove valid liquidity assets", async function () {
            await expect(
                configContract
                    .connect(origOwner)
                    .setLiquidityAsset(mockTokenContract.address, false),
            )
                .to.emit(configContract, "LiquidityAssetRemoved")
                .withArgs(mockTokenContract.address, origOwner.address);
            expect(await configContract.isAssetValid(mockTokenContract.address)).to.equal(false);
        });
    });

    describe("Change EA NFT Contract Address", function () {
        it("Should disallow non-proto-admin to change EANFT Address", async function () {
            await expect(
                configContract.connect(randomUser).setEANFTContractAddress(eaNFTContract.address),
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should reject zero address EANFT contract address", async function () {
            await expect(
                configContract
                    .connect(origOwner)
                    .setEANFTContractAddress(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(configContract, "ZeroAddressProvided");
        });

        it("Should be able to change EANFT Address", async function () {
            await expect(
                configContract.connect(origOwner).setEANFTContractAddress(eaNFTContract.address),
            )
                .to.emit(configContract, "EANFTContractAddressChanged")
                .withArgs(eaNFTContract.address);
            expect(await configContract.eaNFTContractAddress()).to.equal(eaNFTContract.address);
        });
    });
});
