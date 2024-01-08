// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

library LibTimelockController {
    function addTimelockController(
        uint256 minDelay,
        address[] memory poolAdmins,
        address[] memory poolExecutors,
        address defaultAdmin
    ) public returns (address) {
        TimelockController timelock = new TimelockController(
            minDelay,
            poolAdmins,
            poolExecutors,
            defaultAdmin
        );
        return address(timelock);
    }
}
