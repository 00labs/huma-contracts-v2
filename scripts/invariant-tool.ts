async function main() {
    const input = `sender=0x0000000000000000000000000000000a17B60033 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x65c26fC57D9847cF8dF2E4ee0bf45D79cd86Ad96 calldata=withdrawProtocolFee(uint256,uint256) args=[6295442937 [6.295e9], 18189 [1.818e4]]
    sender=0x0000000000000000000000000000000000003309 addr=[test/invariant/handlers/CreditLineHandler.sol:CreditLineHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=drawdown(uint256,uint256,uint256) args=[5347841 [5.347e6], 15670405247728127281328157809421517211 [1.567e37], 3]
    sender=0x000000000000000000000000000005fba0049372 addr=[test/invariant/handlers/CreditLineHandler.sol:CreditLineHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=refreshCredit(uint256,uint256) args=[4263, 2520]
    sender=0x00000000000000000000000000000000000036E2 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x65c26fC57D9847cF8dF2E4ee0bf45D79cd86Ad96 calldata=processYieldForLenders(uint256,uint256) args=[115792089237316195423570985008687907853269984665640564039457584007913129639932 [1.157e77], 1]
    sender=0x000000000000000000000000000000000000065B addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x65c26fC57D9847cF8dF2E4ee0bf45D79cd86Ad96 calldata=withdrawEAFee(uint256,uint256) args=[15053351432307361742623713719147652371 [1.505e37], 49043886841868221141937122443539568202564945841499810464828180727528253368149 [4.904e76]]
    sender=0xbc3c0BFd257d0c62755C127d8d0D24EdF64696B8 addr=[test/invariant/handlers/CreditLineHandler.sol:CreditLineHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=refreshCredit(uint256,uint256) args=[20017 [2.001e4], 16397 [1.639e4]]
    sender=0x0000000000000000000000000000000000004a68 addr=[test/invariant/handlers/CreditLineHandler.sol:CreditLineHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=drawdown(uint256,uint256,uint256) args=[15303 [1.53e4], 13312 [1.331e4], 6668840891114 [6.668e12]]
    sender=0x30BCb7bABa2Cb4B2b6321039Ba30b93a39971716 addr=[test/invariant/handlers/CreditLineHandler.sol:CreditLineHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=refreshCredit(uint256,uint256) args=[10075 [1.007e4], 17201 [1.72e4]]
    sender=0x0000078eDbd4bC77000000000000018a47D16253 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x65c26fC57D9847cF8dF2E4ee0bf45D79cd86Ad96 calldata=deposit(uint256,uint256,uint256,uint256) args=[510537666446219246481773878731528714621978 [5.105e41], 15610 [1.561e4], 83135927887310053417312660604881754261059274354369112460007901204594921022802 [8.313e76], 7904743401573 [7.904e12]]
    sender=0x0000000000000000000000000000000000003F01 addr=[test/invariant/handlers/CreditLineHandler.sol:CreditLineHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=refreshCredit(uint256,uint256) args=[0, 115792089237316195423570985008687907853269984665640564039457584007913129639935 [1.157e77]]
    sender=0x0000000000000000000000000000000000002D27 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x65c26fC57D9847cF8dF2E4ee0bf45D79cd86Ad96 calldata=withdrawPoolOwnerFee(uint256,uint256) args=[2966213749533447012822919233491949898487911115452453710138800539485707820429 [2.966e75], 3389075692647244438667926620621673165930631721915695584711143670 [3.389e63]]
    sender=0x3430bCB8689f1484Ea6EDf8931ed6DE602a867b8 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x65c26fC57D9847cF8dF2E4ee0bf45D79cd86Ad96 calldata=processYieldForLenders(uint256,uint256) args=[3, 115792089237316195423570985008687907853269984665640564039457584007913129639932 [1.157e77]]
    sender=0x0000000000000000000000000000000000002d5D addr=[test/invariant/handlers/CreditLineHandler.sol:CreditLineHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=makePayment(uint256,uint256,uint256) args=[73665470 [7.366e7], 90000004957 [9e10], 34240871492120278444382512037462927889707727989256488054029321212407321995947 [3.424e76]]`;
    const regex = /addr=\[.+\:([a-zA-Z]+)\].+calldata=([a-zA-Z]+)\([^\)]+\)\sargs=\[(.+)\]/g;
    let match;
    let result = "";

    while ((match = regex.exec(input)) !== null) {
        // console.log(`handler: ${match[1]}`);
        const functionName = match[2];
        const argsMatch = match[3];
        // console.log(`argsMatch: ${argsMatch}`);
        const args = argsMatch.split(`,`).map((arg) => {
            // console.log(`arg: ${arg.trim()}, arg0: ${arg.trim().split(` `)[0].trim()}`);
            return arg.trim().split(` `)[0].trim();
        });
        result += `${match[1]}.${functionName}(\n${args.join(",\n")}\n);\n`;
    }

    result = result.replaceAll(`LiquidityHandler`, `liquidityHandler`);
    result = result.replaceAll(`ReceivableBackedCreditLineHandler`, `rbCreditLineHandler`);
    result = result.replaceAll(`CreditLineHandler`, `creditLineHandler`);

    console.log(result);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
