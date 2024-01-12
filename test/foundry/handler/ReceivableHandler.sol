// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Receivable} from "../../../contracts/credit/Receivable.sol";
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import "forge-std/console.sol";
import "forge-std/Vm.sol";

contract ReceivableHandler is Test {
    Receivable public receivable;
    uint256 public receivableCount = 0;

    address[] public actors;
    address internal currentActor;

    modifier useActor(uint256 actorIndexSeed) {
        currentActor = actors[bound(actorIndexSeed, 0, actors.length - 1)];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
    }

    constructor() {
        receivable = Receivable(address(new ERC1967Proxy(address(new Receivable()), "")));
        receivable.initialize();

        // Minter user
        Vm.Wallet memory minter = vm.createWallet("Minter");
        actors.push(minter.addr);
        vm.deal(minter.addr, 10 ether);
        receivable.grantRole(receivable.MINTER_ROLE(), minter.addr);

        // Generic user
        Vm.Wallet memory user = vm.createWallet("User");
        vm.deal(user.addr, 10 ether);
        actors.push(user.addr);
    }

    function createReceivable(
        uint16 currencyCode,
        uint96 receivableAmount,
        uint64 maturityDate,
        string memory referenceId,
        string memory uri,
        uint256 actorIndexSeed
    ) external useActor(actorIndexSeed) {
        receivable.createReceivable(
            currencyCode,
            receivableAmount,
            maturityDate,
            referenceId,
            uri
        );
        receivableCount++;
    }

    function createReceivableBounded(
        uint16 currencyCode,
        uint96 receivableAmount,
        uint64 maturityDate,
        uint256 actorIndexSeed
    ) external useActor(actorIndexSeed) {
        currencyCode = uint16(bound(currencyCode, 0, 65535 - 1));
        receivableAmount = uint96(bound(receivableAmount, 0, 2 ** 96 - 1));
        maturityDate = uint64(bound(maturityDate, 0, 2 ** 64 - 1));

        this.createReceivable(
            currencyCode,
            receivableAmount,
            maturityDate,
            "",
            "uri",
            actorIndexSeed
        );
    }

    function declarePayment(
        uint256 tokenId,
        uint96 paymentAmount,
        uint256 actorIndexSeed
    ) external useActor(actorIndexSeed) {
        receivable.declarePayment(tokenId, paymentAmount);
    }
}
