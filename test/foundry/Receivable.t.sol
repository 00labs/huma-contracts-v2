// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Receivable} from "../../contracts/credit/Receivable.sol";
import {ReceivableHandler} from "./handler/ReceivableHandler.sol";
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import "forge-std/console.sol";

contract ReceivableTest is StdInvariant, Test {
    ReceivableHandler receivableHandler;

    function setUp() public {
        receivableHandler = new ReceivableHandler();
        targetContract(address(receivableHandler));
    }

    function testCreate() public {
        receivableHandler.createReceivable(1, 1, 1, "", "uri", 0);
        assertEq(receivableHandler.receivable().totalSupply(), 1);
    }

    function invariant_supplyEqualsHandlerCount() public {
        assertEq(
            receivableHandler.receivable().totalSupply(),
            receivableHandler.receivableCount()
        );
    }
}
