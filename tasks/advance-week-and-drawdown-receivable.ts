import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber } from "ethers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types/runtime";
import moment from "moment";
import { CONSTANTS } from "../test/constants";

task(
    "advanceWeekAndDrawdownReceivable",
    "Pays back to the pool and draws down with a receivable, then advances blockchain time by a week",
)
    .addParam(
        "poolConfigAddr",
        "The address of the Pool Config whose epoch you wish to advance to next",
    )
    .setAction(async (taskArgs: { poolConfigAddr: string }, hre: HardhatRuntimeEnvironment) => {
        let borrowerActive: SignerWithAddress;

        [, , , , , , , , , , , , borrowerActive] = await hre.ethers.getSigners();

        const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(taskArgs.poolConfigAddr);

        const MockToken = await hre.ethers.getContractFactory("MockToken");
        const mockTokenContract = MockToken.attach(await poolConfigContract.underlyingToken());

        const RecievableBackedCreditLine = await hre.ethers.getContractFactory(
            "ReceivableBackedCreditLine",
        );
        const receivableCreditContract = RecievableBackedCreditLine.attach(
            await poolConfigContract.credit(),
        );

        const Recievable = await hre.ethers.getContractFactory("Receivable");
        const receivableContract = Recievable.attach(await poolConfigContract.receivableAsset());

        const borrowAmount = BigNumber.from(100_000).mul(
            BigNumber.from(10).pow(BigNumber.from(await mockTokenContract.decimals())),
        );

        const currentBlockTimestamp = await time.latest();
        // Mint new receivable for drawdown
        const createDrawdownReceivableTx = await receivableContract
            .connect(borrowerActive)
            .createReceivable(
                1,
                borrowAmount,
                moment.unix(currentBlockTimestamp).add(10, "days").hour(0).unix(),
                "",
                "",
            );
        await createDrawdownReceivableTx.wait();

        // Calculate token ids of payback and drawdown receivables
        const receivablesDrawndownCount = await receivableContract.balanceOf(
            receivableCreditContract.address,
        );
        const receivablesCountOfBorrower = await receivableContract.balanceOf(
            borrowerActive.address,
        );
        const payableReceivableTokenId = await receivableContract.tokenOfOwnerByIndex(
            receivableCreditContract.address,
            receivablesDrawndownCount.toNumber() - 1,
        );
        const drawdownReceivableTokenId = await receivableContract.tokenOfOwnerByIndex(
            borrowerActive.address,
            receivablesCountOfBorrower.toNumber() - 1,
        );

        // Payback and drawdown
        console.log(
            `Payback with tokenId ${payableReceivableTokenId} and drawdown with tokenId ${drawdownReceivableTokenId}`,
        );
        await receivableContract
            .connect(borrowerActive)
            .approve(receivableCreditContract.address, drawdownReceivableTokenId);
        const paybackAndDrawdownTx = await receivableCreditContract
            .connect(borrowerActive)
            .makePrincipalPaymentAndDrawdownWithReceivable(
                payableReceivableTokenId,
                borrowAmount,
                drawdownReceivableTokenId,
                borrowAmount,
            );
        await paybackAndDrawdownTx.wait();

        console.log("Advancing blockchain by 1 week");
        await hre.network.provider.send("evm_increaseTime", [CONSTANTS.SECONDS_IN_A_WEEK]);
        await hre.network.provider.send("evm_mine");
    });
