import { ethers } from "hardhat";
import moment from "moment";

const LOCAL_PROVIDER = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");

export const advanceChainTime = async (date: moment.Moment) => {
    console.log("Advancing to fix date");
    let block = await LOCAL_PROVIDER.getBlock("latest");
    const timeToAdvance = date.unix() - block.timestamp;

    console.log(
        `Advancing blockchain to ${date.toLocaleString()} by ${timeToAdvance} seconds (~${(
            timeToAdvance /
            60 /
            60 /
            24
        ).toPrecision(3)} days)`,
    );

    await LOCAL_PROVIDER.send("evm_increaseTime", [timeToAdvance]);
    await LOCAL_PROVIDER.send("evm_mine", []);
    block = await LOCAL_PROVIDER.getBlock("latest");
    console.log("Block timestamp after advancing: ", block.timestamp);
};
